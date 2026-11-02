import { randomUUID } from 'node:crypto'

import { Clock, Context, Effect, Layer, Option, Ref } from 'effect'
import { HttpClient } from 'effect/http'

import { GarminApi } from './api.ts'
import { type GarminError, LoginRefused, type NotLoggedIn, type RateLimited } from './errors.ts'
import { type Account, GarminSession } from './session.ts'
import { expiresAt, login, type PendingMfa, type Tokens, verifyMfa } from './sso.ts'
import { GarminSync } from './sync.ts'

// Logging the Garmin account in, for the web app (/garmin) and the CLI: the email and password,
// then the MFA code when Garmin asks for one (its email or its app). Between the two steps the
// SSO's cookies wait here, in memory, 10 minutes at most. A new session replaces the previous one
// once Garmin's API accepts it, then the sync starts.

export type LoginFailure = LoginRefused | RateLimited | GarminError | NotLoggedIn

export type LoginStart =
  | { readonly _tag: 'LoggedIn'; readonly account: Account }
  | { readonly _tag: 'NeedsMfa'; readonly id: string; readonly method: string }

export interface SessionStatus {
  readonly logged_in: boolean
  readonly account: Account | null
  // The access token's expiry: it is refreshed before, from the refresh token
  readonly expires_at: string | null
  readonly saved_at: string | null
  readonly refreshable: boolean
}

const PENDING_FOR_MS = 10 * 60 * 1000

export class GarminLogin extends Context.Service<
  GarminLogin,
  {
    readonly start: (credentials: {
      readonly email: string
      readonly password: string
    }) => Effect.Effect<LoginStart, LoginFailure>
    readonly mfa: (id: string, code: string) => Effect.Effect<Account, LoginFailure>
    readonly status: Effect.Effect<SessionStatus>
    readonly logout: Effect.Effect<void, GarminError>
  }
>()('garmin/GarminLogin') {
  static readonly layer = Layer.effect(
    GarminLogin,
    Effect.gen(function* () {
      const http = yield* HttpClient.HttpClient
      const session = yield* GarminSession
      const api = yield* GarminApi
      const sync = yield* GarminSync
      const pending = yield* Ref.make(
        new Map<string, { readonly mfa: PendingMfa; readonly until: number }>()
      )

      // Saved, then checked against the API (its profile names the account): a token the API
      // refuses is not kept
      const adopt = (tokens: Tokens) =>
        Effect.gen(function* () {
          const previous = yield* session.load
          yield* session.save(tokens, null)
          const account = yield* api.profile.pipe(
            Effect.tapError(() =>
              Option.match(previous, {
                onNone: () => session.clear,
                onSome: (saved) => session.save(saved, saved.account ?? null),
              }).pipe(Effect.ignore)
            )
          )
          yield* session.save(tokens, account)
          yield* Effect.logInfo(`Garmin: logged in as ${account.full_name ?? account.display_name}`)
          yield* sync.trigger
          return account
        })

      const start = Effect.fn('GarminLogin.start')(function* (credentials: {
        readonly email: string
        readonly password: string
      }) {
        const email = credentials.email.trim()
        if (email === '' || credentials.password === '') {
          return yield* new LoginRefused({ message: 'the email and the password are required' })
        }
        const step = yield* login(email, credentials.password).pipe(
          Effect.provideService(HttpClient.HttpClient, http)
        )
        if (step._tag === 'LoggedIn') {
          return { _tag: 'LoggedIn', account: yield* adopt(step.tokens) } satisfies LoginStart
        }
        const id = randomUUID()
        const now = yield* Clock.currentTimeMillis
        yield* Ref.update(pending, (map) => {
          return new Map([
            ...[...map].filter(([, entry]) => entry.until > now),
            [id, { mfa: step.mfa, until: now + PENDING_FOR_MS }],
          ])
        })
        return { _tag: 'NeedsMfa', id, method: step.mfa.method } satisfies LoginStart
      })

      const mfa = Effect.fn('GarminLogin.mfa')(function* (id: string, code: string) {
        const now = yield* Clock.currentTimeMillis
        const entry = (yield* Ref.get(pending)).get(id)
        if (entry === undefined || entry.until < now) {
          return yield* new LoginRefused({
            message: 'this login expired (10 minutes): start again with the email and password',
          })
        }
        if (!/^\d{4,8}$/u.test(code.trim())) {
          return yield* new LoginRefused({ message: 'the MFA code is the 6 digits Garmin sent' })
        }
        const tokens = yield* verifyMfa(entry.mfa, code).pipe(
          Effect.provideService(HttpClient.HttpClient, http)
        )
        yield* Ref.update(pending, (map) => {
          const next = new Map(map)
          next.delete(id)
          return next
        })
        return yield* adopt(tokens)
      })

      const status = Effect.map(session.load, (saved): SessionStatus =>
        Option.match(saved, {
          onNone: () => ({
            logged_in: false,
            account: null,
            expires_at: null,
            saved_at: null,
            refreshable: false,
          }),
          onSome: (value) => ({
            logged_in: true,
            account: value.account ?? null,
            expires_at: expiresAt(value.di_token)?.toISOString() ?? null,
            saved_at: value.saved_at ?? null,
            refreshable: value.di_refresh_token !== null,
          }),
        })
      )

      return GarminLogin.of({ start, mfa, status, logout: session.clear })
    })
  )
}

// A failure as a sentence for the user (the web app and the CLI speak French; Garmin's details stay
// as they are, in parentheses)
const REFUSALS: Record<string, string> = {
  'Garmin refused the email or the password': 'Garmin a refusé l’email ou le mot de passe.',
  'Garmin refused the MFA code':
    'Garmin a refusé le code MFA : vérifie-le, ou recommence pour en recevoir un nouveau.',
  'Garmin says the account is locked':
    'Garmin indique que le compte est verrouillé : débloque-le sur connect.garmin.com.',
  'the email and the password are required': 'L’email et le mot de passe sont requis.',
  'the MFA code is the 6 digits Garmin sent':
    'Le code MFA, ce sont les 6 chiffres envoyés par Garmin.',
  'this login expired (10 minutes): start again with the email and password':
    'Cette connexion a expiré (10 minutes) : recommence avec l’email et le mot de passe.',
}

export const explain = (error: LoginFailure) => {
  switch (error._tag) {
    case 'LoginRefused':
      return REFUSALS[error.message] ?? error.message
    case 'RateLimited':
      return `Garmin limite les connexions depuis cette adresse : réessaie dans quelques minutes (une heure au pire). (${error.message})`
    case 'NotLoggedIn':
      return `Garmin a accepté la connexion mais son API refuse la session : réessaie. (${error.message})`
    case 'GarminError':
      return /429|rate limit|Cloudflare|captcha/iu.test(error.message)
        ? `Garmin bloque les connexions depuis cette adresse pour l’instant : réessaie plus tard, ou depuis le serveur. (${error.message})`
        : `La connexion à Garmin n’a pas abouti. (${error.message})`
  }
}
