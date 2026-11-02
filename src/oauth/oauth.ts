import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { and, desc, eq, gt, inArray, lte, notInArray } from 'drizzle-orm'
import { Clock, Config, Context, Effect, Layer, Option } from 'effect'

import { failureLog } from '../auth.ts'
import { connect } from '../db.ts'

import { accessTokens, clients, grants } from './schema.ts'

// The MCP's OAuth 2.1 authorization server, as MCP clients (Claude Code) expect it: they find it
// from the MCP's 401 (RFC 9728, then RFC 8414), register themselves (RFC 7591, public clients),
// send the browser to /authorize, where the owner, logged in to the web app, allows them, then
// trade the code for tokens with PKCE (S256). Access tokens last an hour, refresh tokens 30 days,
// rotated at each use. Only their SHA-256 is kept, in AUTH_DATABASE_PATH. A new password revokes
// every grant (see routes/auth/password.ts); /access revokes one.

export const SCOPE = 'mcp'
const ACCESS_MS = 3_600_000
const REFRESH_MS = 30 * 86_400_000
const CODE_MS = 60_000
// Registrations nothing was ever authorized for: the newest only past 10 minutes (registering is
// open, throttled per address)
const IDLE_CLIENTS = 20
const YOUNG_MS = 600_000
// A previous refresh token presented this soon after its rotation: two processes of one client
// refreshing at once, not a leak
const RACE_MS = 30_000
const ACCESS_PREFIX = 'gma_'
const REFRESH_PREFIX = 'gmr_'

export const migrationsFolder = 'drizzle-auth'

// RFC 6749's error answers (and RFC 7591's for the registration)
export type OAuthError = { readonly error: string; readonly error_description: string }
const failure = (error: string, description: string): OAuthError => ({
  error,
  error_description: description,
})

export interface RegisteredClient {
  readonly client_id: string
  readonly client_id_issued_at: number
  readonly client_name: string
  readonly redirect_uris: ReadonlyArray<string>
  readonly grant_types: ReadonlyArray<string>
  readonly response_types: ReadonlyArray<string>
  readonly token_endpoint_auth_method: 'none'
}

export interface TokenAnswer {
  readonly access_token: string
  readonly token_type: 'Bearer'
  readonly expires_in: number
  readonly refresh_token: string
  readonly scope: string
}

// /authorize's query, as given
export interface AuthorizeRequest {
  readonly response_type?: string | undefined
  readonly client_id?: string | undefined
  readonly redirect_uri?: string | undefined
  readonly code_challenge?: string | undefined
  readonly code_challenge_method?: string | undefined
  readonly state?: string | undefined
  readonly scope?: string | undefined
  readonly resource?: string | undefined
}

// A request fit to be shown to the owner, and approved
export interface Authorization {
  readonly client_id: string
  readonly client_name: string
  readonly redirect_uri: string
  readonly code_challenge: string
  readonly state: string | undefined
  readonly resource: string
}

// Why a request is not shown: never sent back to its redirect_uri, which may not be the client's
export type Refusal = 'client' | 'redirect' | 'response_type' | 'pkce' | 'resource' | 'state'

export interface GrantView {
  readonly id: string
  readonly client_name: string
  readonly redirect_host: string
  readonly created_at: string
  readonly used_at: string
}

// One of this server's tokens, by its look: never a password to check
export const isOAuthToken = (value: string) =>
  value.startsWith(ACCESS_PREFIX) || value.startsWith(REFRESH_PREFIX)

// The same MCP: a trailing slash aside
const sameResource = (asked: string, resource: string) =>
  asked.replace(/\/$/u, '') === resource.replace(/\/$/u, '')

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')
const token = (prefix: string) => `${prefix}${randomBytes(32).toString('base64url')}`
const iso = (ms: number) => new Date(ms).toISOString()

// An https address, or http on this machine (a native app's loopback, RFC 8252); no fragment
export const redirectAllowed = (uri: string) => {
  if (uri.length > 512) return false
  try {
    const url = new URL(uri)
    if (url.hash !== '' || url.username !== '' || url.password !== '') return false
    if (url.protocol === 'https:') return true
    return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  } catch {
    return false
  }
}

const verifierPattern = /^[A-Za-z0-9._~-]{43,128}$/u
const challengePattern = /^[A-Za-z0-9_-]{43}$/u

// PKCE S256: the verifier's SHA-256, base64url, is the challenge given to /authorize
export const pkceMatches = (verifier: string, challenge: string) => {
  if (!verifierPattern.test(verifier)) return false
  const computed = Buffer.from(createHash('sha256').update(verifier).digest('base64url'))
  const expected = Buffer.from(challenge)
  return computed.length === expected.length && timingSafeEqual(computed, expected)
}

interface PendingCode {
  readonly client_id: string
  readonly redirect_uri: string
  readonly code_challenge: string
  readonly resource: string
  readonly expires: number
}

export class OAuth extends Context.Service<
  OAuth,
  {
    // An application registering itself, from `client` (see auth.ts's clientOf)
    readonly register: (
      body: unknown,
      client: string
    ) => Effect.Effect<RegisteredClient | OAuthError | 'throttled'>
    // An authorization request for the MCP at `resource`, checked
    readonly check: (
      request: AuthorizeRequest,
      resource: string
    ) => Effect.Effect<Authorization | Refusal>
    // Where the browser goes back to: the client's redirect_uri with a code, or with access_denied
    readonly answer: (
      request: AuthorizeRequest,
      resource: string,
      issuer: string,
      allowed: boolean
    ) => Effect.Effect<{ readonly location: string } | Refusal>
    // The token endpoint: a code or a refresh token for tokens (of the MCP the code was for)
    readonly token: (
      field: (name: string) => string | null
    ) => Effect.Effect<TokenAnswer | OAuthError>
    // RFC 7009: the grant of an access or refresh token, revoked
    readonly revoke: (token: string) => Effect.Effect<void>
    // An access token for the MCP at `resource`
    readonly verify: (token: string, resource: string) => Effect.Effect<boolean>
    readonly grants: Effect.Effect<ReadonlyArray<GrantView>>
    readonly revokeGrant: (id: string) => Effect.Effect<void>
    readonly revokeAll: Effect.Effect<void>
  }
>()('garmin/OAuth') {
  static readonly layer = Layer.effect(
    OAuth,
    Effect.gen(function* () {
      const passwordPath = yield* Config.String('PASSWORD_PATH').pipe(
        Config.withDefault(join('.tokens', 'password'))
      )
      const path = yield* Config.String('AUTH_DATABASE_PATH').pipe(
        Config.withDefault(join(dirname(passwordPath), 'auth.db'))
      )
      yield* Effect.promise(() => mkdir(dirname(path), { recursive: true, mode: 0o700 }))
      const { use: tryUse } = yield* connect(path, migrationsFolder, { foreignKeys: true }).pipe(
        Effect.orDie
      )
      // A failing query is a defect: the request fails, nothing is half done (one statement or
      // one transaction each)
      const use = <A>(run: Parameters<typeof tryUse<A>>[0]) => Effect.orDie(tryUse(run))
      const now = Clock.currentTimeMillis

      // Codes live a minute, in memory: one use each
      const codes = new Map<string, PendingCode>()
      // Registrations, per address and in all: 10 and 60 a minute
      const registrations = failureLog()

      const register = Effect.fn('OAuth.register')(function* (body: unknown, from: string) {
        const at = yield* now
        if (registrations.blocked(from, at)) return 'throttled' as const
        registrations.record(from, at)
        if (typeof body !== 'object' || body === null) {
          return failure('invalid_client_metadata', 'A JSON object is expected.')
        }
        const metadata = body as Record<string, unknown>
        const uris = metadata['redirect_uris']
        if (
          !Array.isArray(uris) ||
          uris.length === 0 ||
          uris.length > 5 ||
          !uris.every((uri): uri is string => typeof uri === 'string' && redirectAllowed(uri))
        ) {
          return failure(
            'invalid_redirect_uri',
            'One to five redirect URIs: https, or http on localhost.'
          )
        }
        const grantTypes = metadata['grant_types']
        if (
          grantTypes !== undefined &&
          !(Array.isArray(grantTypes) && grantTypes.includes('authorization_code'))
        ) {
          return failure('invalid_client_metadata', 'Only the authorization code grant.')
        }
        const named = metadata['client_name']
        const name =
          typeof named === 'string' && named.trim() !== ''
            ? named.trim().slice(0, 100)
            : 'Application MCP'
        const id = randomUUID()
        yield* use((db) =>
          db.transaction((tx) => {
            tx.insert(clients)
              .values({ id, name, redirect_uris: uris, created_at: iso(at) })
              .run()
            // The idle registrations past the newest IDLE_CLIENTS, but the young ones (one may be
            // on its way through /authorize)
            const authorized = tx.select({ id: grants.client_id }).from(grants)
            const idle = tx
              .select({ id: clients.id })
              .from(clients)
              .where(
                and(notInArray(clients.id, authorized), lte(clients.created_at, iso(at - YOUNG_MS)))
              )
              .orderBy(desc(clients.created_at))
              .limit(-1)
              .offset(IDLE_CLIENTS)
              .all()
            if (idle.length > 0) {
              tx.delete(clients)
                .where(
                  inArray(
                    clients.id,
                    idle.map((client) => client.id)
                  )
                )
                .run()
            }
          })
        )
        return {
          client_id: id,
          client_id_issued_at: Math.floor(at / 1000),
          client_name: name,
          redirect_uris: uris,
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          token_endpoint_auth_method: 'none',
        } satisfies RegisteredClient
      })

      const check = Effect.fn('OAuth.check')(function* (
        request: AuthorizeRequest,
        resource: string
      ) {
        const client =
          request.client_id === undefined
            ? undefined
            : yield* use((db) =>
                db
                  .select()
                  .from(clients)
                  .where(eq(clients.id, request.client_id ?? ''))
                  .get()
              )
        if (client === undefined) return 'client' satisfies Refusal
        const redirect = request.redirect_uri
        if (redirect === undefined || !client.redirect_uris.includes(redirect)) {
          return 'redirect' satisfies Refusal
        }
        if (request.response_type !== 'code') return 'response_type' satisfies Refusal
        const challenge = request.code_challenge
        if (
          request.code_challenge_method !== 'S256' ||
          challenge === undefined ||
          !challengePattern.test(challenge)
        ) {
          return 'pkce' satisfies Refusal
        }
        if (request.resource !== undefined && !sameResource(request.resource, resource)) {
          return 'resource' satisfies Refusal
        }
        if (request.state !== undefined && request.state.length > 1024) {
          return 'state' satisfies Refusal
        }
        return {
          client_id: client.id,
          client_name: client.name,
          redirect_uri: redirect,
          code_challenge: challenge,
          state: request.state,
          resource,
        } satisfies Authorization
      })

      const answer = Effect.fn('OAuth.answer')(function* (
        request: AuthorizeRequest,
        resource: string,
        issuer: string,
        allowed: boolean
      ) {
        const checked = yield* check(request, resource)
        if (typeof checked === 'string') return checked
        const back = new URL(checked.redirect_uri)
        if (allowed) {
          const at = yield* now
          for (const [key, pending] of codes) if (pending.expires <= at) codes.delete(key)
          const code = randomBytes(32).toString('base64url')
          codes.set(sha256(code), {
            client_id: checked.client_id,
            redirect_uri: checked.redirect_uri,
            code_challenge: checked.code_challenge,
            resource: checked.resource,
            expires: at + CODE_MS,
          })
          back.searchParams.set('code', code)
        } else {
          back.searchParams.set('error', 'access_denied')
        }
        if (checked.state !== undefined) back.searchParams.set('state', checked.state)
        // RFC 9207: which server answers
        back.searchParams.set('iss', issuer)
        return { location: back.toString() }
      })

      // New tokens: an access token, and a refresh token to put on the grant
      const mint = (at: number) => {
        const access = token(ACCESS_PREFIX)
        const refresh = token(REFRESH_PREFIX)
        return {
          access: { hash: sha256(access), expires_at: iso(at + ACCESS_MS) },
          refresh: { hash: sha256(refresh), expires_at: iso(at + REFRESH_MS) },
          answer: {
            access_token: access,
            token_type: 'Bearer',
            expires_in: ACCESS_MS / 1000,
            refresh_token: refresh,
            scope: SCOPE,
          } satisfies TokenAnswer,
        }
      }

      // The expired: access tokens, and grants whose refresh token expired
      const sweep = (at: number) =>
        use((db) =>
          db.transaction((tx) => {
            tx.delete(accessTokens)
              .where(lte(accessTokens.expires_at, iso(at)))
              .run()
            tx.delete(grants)
              .where(lte(grants.refresh_expires_at, iso(at)))
              .run()
          })
        )

      const token_ = Effect.fn('OAuth.token')(function* (field: (name: string) => string | null) {
        const at = yield* now
        yield* sweep(at)
        const clientId = field('client_id')
        const asked = field('resource')
        if (clientId === null) return failure('invalid_request', 'client_id is missing.')
        switch (field('grant_type')) {
          case 'authorization_code': {
            const code = field('code')
            const verifier = field('code_verifier')
            if (code === null || verifier === null) {
              return failure('invalid_request', 'code and code_verifier are required.')
            }
            const key = sha256(code)
            const pending = codes.get(key)
            codes.delete(key)
            if (
              pending === undefined ||
              pending.expires <= at ||
              pending.client_id !== clientId ||
              pending.redirect_uri !== field('redirect_uri') ||
              !pkceMatches(verifier, pending.code_challenge) ||
              (asked !== null && !sameResource(asked, pending.resource))
            ) {
              return failure('invalid_grant', 'The code is invalid, used or expired.')
            }
            const minted = mint(at)
            const created = yield* use((db) =>
              db.transaction((tx) => {
                const client = tx
                  .select({ id: clients.id })
                  .from(clients)
                  .where(eq(clients.id, clientId))
                  .get()
                if (client === undefined) return false
                const grantId = randomUUID()
                tx.insert(grants)
                  .values({
                    id: grantId,
                    client_id: clientId,
                    scope: SCOPE,
                    resource: pending.resource,
                    created_at: iso(at),
                    used_at: iso(at),
                    refresh_hash: minted.refresh.hash,
                    refresh_expires_at: minted.refresh.expires_at,
                    refreshed_at: iso(at),
                  })
                  .run()
                tx.insert(accessTokens)
                  .values({ ...minted.access, grant_id: grantId })
                  .run()
                return true
              })
            )
            if (!created) return failure('invalid_client', 'The client is no longer registered.')
            return minted.answer
          }
          case 'refresh_token': {
            const refresh = field('refresh_token')
            if (refresh === null) return failure('invalid_request', 'refresh_token is required.')
            const hash = sha256(refresh)
            const minted = mint(at)
            // One transaction: two refreshes with one token never both win
            const rotated = yield* use((db) =>
              db.transaction((tx) => {
                const grant = tx.select().from(grants).where(eq(grants.refresh_hash, hash)).get()
                if (grant === undefined) {
                  // Spent already: a leak, unless a concurrent refresh just rotated it
                  const spent = tx
                    .select()
                    .from(grants)
                    .where(eq(grants.previous_refresh_hash, hash))
                    .get()
                  if (spent !== undefined && Date.parse(spent.refreshed_at) <= at - RACE_MS) {
                    tx.delete(grants).where(eq(grants.id, spent.id)).run()
                  }
                  return false
                }
                if (
                  grant.refresh_expires_at <= iso(at) ||
                  grant.client_id !== clientId ||
                  (asked !== null && !sameResource(asked, grant.resource))
                ) {
                  return false
                }
                tx.update(grants)
                  .set({
                    refresh_hash: minted.refresh.hash,
                    refresh_expires_at: minted.refresh.expires_at,
                    previous_refresh_hash: hash,
                    refreshed_at: iso(at),
                    used_at: iso(at),
                  })
                  .where(eq(grants.id, grant.id))
                  .run()
                tx.insert(accessTokens)
                  .values({ ...minted.access, grant_id: grant.id })
                  .run()
                return true
              })
            )
            if (!rotated) {
              return failure('invalid_grant', 'The refresh token is invalid, used or expired.')
            }
            return minted.answer
          }
          default: {
            return failure('unsupported_grant_type', 'authorization_code or refresh_token only.')
          }
        }
      })

      const revoke = Effect.fn('OAuth.revoke')(function* (given: string) {
        const hash = sha256(given)
        yield* use((db) =>
          db.transaction((tx) => {
            const access = tx
              .select({ grant: accessTokens.grant_id })
              .from(accessTokens)
              .where(eq(accessTokens.hash, hash))
              .get()
            if (access !== undefined) {
              tx.delete(grants).where(eq(grants.id, access.grant)).run()
            }
            tx.delete(grants).where(eq(grants.refresh_hash, hash)).run()
          })
        )
      })

      const verify = Effect.fn('OAuth.verify')(function* (given: string, resource: string) {
        if (!given.startsWith(ACCESS_PREFIX)) return false
        const at = yield* now
        const found = yield* use((db) =>
          db
            .select({ grant: grants.id, resource: grants.resource })
            .from(accessTokens)
            .innerJoin(grants, eq(grants.id, accessTokens.grant_id))
            .where(and(eq(accessTokens.hash, sha256(given)), gt(accessTokens.expires_at, iso(at))))
            .get()
        )
        if (found === undefined || found.resource !== resource) return false
        yield* use((db) =>
          db
            .update(grants)
            .set({ used_at: iso(at) })
            .where(eq(grants.id, found.grant))
            .run()
        )
        return true
      })

      const list = use((db) =>
        db
          .select({
            id: grants.id,
            client_name: clients.name,
            redirect_uris: clients.redirect_uris,
            created_at: grants.created_at,
            used_at: grants.used_at,
          })
          .from(grants)
          .innerJoin(clients, eq(clients.id, grants.client_id))
          .orderBy(desc(grants.used_at))
          .all()
      ).pipe(
        Effect.map((rows) =>
          rows.map(({ redirect_uris, ...row }): GrantView => ({
            ...row,
            redirect_host: Option.fromNullishOr(redirect_uris[0]).pipe(
              Option.map((uri) => new URL(uri).host),
              Option.getOrElse(() => '')
            ),
          }))
        )
      )

      return OAuth.of({
        register,
        check,
        answer,
        token: token_,
        revoke,
        verify,
        grants: list,
        revokeGrant: (id) =>
          Effect.asVoid(use((db) => db.delete(grants).where(eq(grants.id, id)).run())),
        revokeAll: Effect.asVoid(
          Effect.andThen(
            use((db) => db.delete(grants).run()),
            Effect.sync(() => codes.clear())
          )
        ),
      })
    })
  )
}
