import { dirname, join, basename } from 'node:path'

import {
  Clock,
  Config,
  Context,
  Effect,
  FileSystem,
  Layer,
  Option,
  Schema,
  Semaphore,
} from 'effect'
import { HttpClient } from 'effect/http'

import { GarminError, NotLoggedIn, type RateLimited } from './errors.ts'
import { expiresAt, expiresSoon, refresh, type Tokens, TokensJson } from './sso.ts'

// The Garmin session, the only secret the app keeps of the account: its tokens, in their own file
// (GARMIN_SESSION_PATH, 0600 in a 0700 directory), never in SQLite (the MCP's SQL reads it) nor in
// data/, never logged. The password is never stored: once Garmin refuses the refresh token, log in
// again (/garmin, or `pnpm garmin login`).

export const AccountJson = Schema.Struct({
  display_name: Schema.String,
  full_name: Schema.NullOr(Schema.String),
})
export type Account = typeof AccountJson.Type

export const SavedJson = Schema.Struct({
  ...TokensJson.fields,
  account: Schema.optional(Schema.NullOr(AccountJson)),
  saved_at: Schema.optional(Schema.String),
})
export type Saved = typeof SavedJson.Type

const decode = Schema.decodeUnknownOption(Schema.fromJsonString(SavedJson))

export const LOGIN_HINT = 'log in again on the web app (/garmin) or with `pnpm garmin login`'

export class GarminSession extends Context.Service<
  GarminSession,
  {
    readonly path: string
    // The saved session, none without a file (or an unreadable one)
    readonly load: Effect.Effect<Option.Option<Saved>>
    readonly save: (tokens: Tokens, account: Account | null) => Effect.Effect<Saved, GarminError>
    readonly clear: Effect.Effect<void, GarminError>
    // A valid access token, refreshed (and saved) when it expires within 15 minutes, or when it
    // is `rejected` (the API's 401) and no other call refreshed it meanwhile
    readonly accessToken: (options?: {
      readonly rejected?: string
    }) => Effect.Effect<string, NotLoggedIn | RateLimited | GarminError>
  }
>()('garmin/GarminSession') {
  static readonly layer = Layer.effect(
    GarminSession,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const http = yield* HttpClient.HttpClient
      const path = yield* Config.String('GARMIN_SESSION_PATH').pipe(
        Config.withDefault(join('.tokens', 'garmin.json'))
      )
      // One refresh at a time: the refresh token may be single-use
      const lock = yield* Semaphore.make(1)

      const load = fs.readFileString(path).pipe(
        Effect.map(decode),
        Effect.orElseSucceed(() => Option.none<Saved>())
      )

      const save = (tokens: Tokens, account: Account | null) =>
        Effect.gen(function* () {
          const saved: Saved = {
            di_token: tokens.di_token,
            di_refresh_token: tokens.di_refresh_token,
            di_client_id: tokens.di_client_id,
            account,
            saved_at: new Date(yield* Clock.currentTimeMillis).toISOString(),
          }
          const directory = dirname(path)
          const partial = join(directory, `.${basename(path)}.partial`)
          yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 })
          yield* fs.chmod(directory, 0o700)
          // Created 0600, then moved over the previous one: never half written, never readable
          yield* fs.writeFileString(partial, JSON.stringify(saved), { mode: 0o600 })
          yield* fs.chmod(partial, 0o600)
          yield* fs.rename(partial, path)
          return saved
        }).pipe(
          Effect.mapError(
            (error) => new GarminError({ message: `saving the session: ${error.message}` })
          )
        )

      const clear = fs
        .remove(path, { force: true })
        .pipe(
          Effect.mapError(
            (error) => new GarminError({ message: `forgetting the session: ${error.message}` })
          )
        )

      const accessToken = (options?: { readonly rejected?: string }) =>
        lock.withPermits(1)(
          Effect.gen(function* () {
            const saved = yield* load
            if (Option.isNone(saved)) {
              return yield* new NotLoggedIn({ message: `no Garmin session: ${LOGIN_HINT}` })
            }
            const now = new Date(yield* Clock.currentTimeMillis)
            const rejected = options?.rejected === saved.value.di_token
            if (!rejected && !expiresSoon(saved.value, now)) return saved.value.di_token
            const refused = yield* refresh(saved.value).pipe(
              Effect.provideService(HttpClient.HttpClient, http),
              Effect.map((fresh) => ({ fresh })),
              Effect.catchTag('NotLoggedIn', (error) => Effect.succeed({ error }))
            )
            if ('error' in refused) {
              // Another process (a CLI's sync beside the app) may have refreshed the same token
              // first, Garmin then refusing it here: its new session is in the file
              const now = yield* load
              if (
                Option.isSome(now) &&
                now.value.di_refresh_token !== saved.value.di_refresh_token &&
                !expiresSoon(now.value, new Date(yield* Clock.currentTimeMillis))
              ) {
                return now.value.di_token
              }
              return yield* new NotLoggedIn({ message: `${refused.error.message}: ${LOGIN_HINT}` })
            }
            const { fresh } = refused
            yield* save(fresh, saved.value.account ?? null)
            yield* Effect.logInfo(
              `Garmin session refreshed, valid until ${expiresAt(fresh.di_token)?.toISOString() ?? '?'}`
            )
            return fresh.di_token
          })
        )

      return GarminSession.of({ path, load, save, clear, accessToken })
    })
  )
}
