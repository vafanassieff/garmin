import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, layer } from '@effect/vitest'
import { ConfigProvider, Effect, Layer } from 'effect'
import { TestClock } from 'effect/testing'

import {
  type Authorization,
  OAuth,
  type OAuthError,
  pkceMatches,
  redirectAllowed,
  type RegisteredClient,
  type TokenAnswer,
} from './oauth.ts'

const RESOURCE = 'https://garmin.test/mcp'
const ISSUER = 'https://garmin.test'
const REDIRECT = 'http://localhost:4567/callback'

// The OAuth database in a fresh directory, removed with the layer
const authDir = Layer.unwrap(
  Effect.acquireRelease(
    Effect.sync(() => mkdtempSync(join(tmpdir(), 'garmin-oauth-'))),
    (directory) => Effect.sync(() => rmSync(directory, { recursive: true, force: true }))
  ).pipe(
    Effect.map((directory) =>
      ConfigProvider.layer(
        ConfigProvider.fromUnknown({ PASSWORD_PATH: join(directory, 'session', 'password') })
      )
    )
  )
)

const pkce = () => {
  const verifier = randomBytes(32).toString('base64url')
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }
}

const isError = (value: unknown): value is OAuthError =>
  typeof value === 'object' && value !== null && 'error' in value

const CLAUDE_CODE = { client_name: 'Claude Code', redirect_uris: [REDIRECT] }

// Each from its own address: registrations are throttled per address
let addresses = 0
const register = (body: unknown = CLAUDE_CODE) =>
  OAuth.use((oauth) => oauth.register(body, `10.0.0.${(addresses += 1)}`)).pipe(
    Effect.map((client) => {
      if (client === 'throttled' || isError(client)) throw new Error(String(client))
      return client
    })
  )

const form = (fields: Record<string, string>) => (name: string) => fields[name] ?? null

// The browser's round trip: /authorize allowed, the code from the redirect
const authorize = (client: RegisteredClient, challenge: string, extra = {}) =>
  OAuth.use((oauth) =>
    oauth.answer(
      {
        response_type: 'code',
        client_id: client.client_id,
        redirect_uri: REDIRECT,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state: 'xyz',
        resource: RESOURCE,
        ...extra,
      },
      RESOURCE,
      ISSUER,
      true
    )
  ).pipe(
    Effect.map((answer) => {
      if (typeof answer === 'string') throw new Error(answer)
      const url = new URL(answer.location)
      expect(url.origin + url.pathname).toBe(REDIRECT)
      expect(url.searchParams.get('state')).toBe('xyz')
      expect(url.searchParams.get('iss')).toBe(ISSUER)
      return url.searchParams.get('code') ?? ''
    })
  )

const exchange = (client: RegisteredClient, code: string, verifier: string, extra = {}) =>
  OAuth.use((oauth) =>
    oauth.token(
      form({
        grant_type: 'authorization_code',
        client_id: client.client_id,
        code,
        code_verifier: verifier,
        redirect_uri: REDIRECT,
        resource: RESOURCE,
        ...extra,
      })
    )
  )

const tokens = (answer: TokenAnswer | OAuthError) => {
  if (isError(answer)) throw new Error(answer.error)
  return answer
}

const verify = (token: string, resource = RESOURCE) =>
  OAuth.use((oauth) => oauth.verify(token, resource))

layer(OAuth.layer.pipe(Layer.provide(authDir)))('OAuth', (it) => {
  it.effect('registers public clients with safe redirect URIs only', () =>
    Effect.gen(function* () {
      const client = yield* register()
      expect(client).toMatchObject({
        client_name: 'Claude Code',
        redirect_uris: [REDIRECT],
        token_endpoint_auth_method: 'none',
      })
      const oauth = yield* OAuth
      for (const body of [
        null,
        {},
        { redirect_uris: [] },
        { redirect_uris: ['http://evil.test/callback'] },
        { redirect_uris: ['javascript:alert(1)'] },
        { redirect_uris: ['https://x.test/cb#frag'] },
        { redirect_uris: [REDIRECT], grant_types: ['client_credentials'] },
      ]) {
        expect(isError(yield* oauth.register(body, 'bad')), JSON.stringify(body)).toBe(true)
      }
      // Ten a minute per address
      for (let i = 0; i < 3; i += 1) yield* oauth.register(CLAUDE_CODE, 'bad')
      expect(yield* oauth.register(CLAUDE_CODE, 'bad')).toBe('throttled')
      expect(yield* oauth.register(CLAUDE_CODE, 'good')).toMatchObject({
        client_name: 'Claude Code',
      })
      expect(redirectAllowed('http://127.0.0.1:9/cb')).toBe(true)
      expect(redirectAllowed('http://[::1]:9/cb')).toBe(true)
      expect(redirectAllowed('https://claude.ai/api/mcp/auth_callback')).toBe(true)
      expect(redirectAllowed('http://localhost.evil.test/cb')).toBe(false)
    })
  )

  it.effect('refuses to show a request it cannot trust', () =>
    Effect.gen(function* () {
      const client = yield* register()
      const oauth = yield* OAuth
      const { challenge } = pkce()
      const good = {
        response_type: 'code',
        client_id: client.client_id,
        redirect_uri: REDIRECT,
        code_challenge: challenge,
        code_challenge_method: 'S256',
      }
      const shown = (yield* oauth.check(good, RESOURCE)) as Authorization
      expect(shown).toMatchObject({ client_name: 'Claude Code', resource: RESOURCE })
      const refusal = (extra: object) => oauth.check({ ...good, ...extra }, RESOURCE)
      expect(yield* refusal({ client_id: 'nope' })).toBe('client')
      expect(yield* refusal({ redirect_uri: 'http://localhost:1/other' })).toBe('redirect')
      expect(yield* refusal({ response_type: 'token' })).toBe('response_type')
      expect(yield* refusal({ code_challenge_method: 'plain' })).toBe('pkce')
      expect(yield* refusal({ code_challenge: undefined })).toBe('pkce')
      expect(yield* refusal({ resource: 'https://other.test/mcp' })).toBe('resource')
      // Refused: nothing to send back
      expect(yield* oauth.answer({ ...good, client_id: 'nope' }, RESOURCE, ISSUER, true)).toBe(
        'client'
      )
      // Denied: the client hears it
      const refused = yield* oauth.answer({ ...good, state: 's' }, RESOURCE, ISSUER, false)
      if (typeof refused === 'string') throw new Error(refused)
      const denied = new URL(refused.location)
      expect(denied.searchParams.get('error')).toBe('access_denied')
      expect(denied.searchParams.get('state')).toBe('s')
      expect(denied.searchParams.get('code')).toBeNull()
    })
  )

  it.effect('trades a code once, with its PKCE verifier, for tokens of the MCP', () =>
    Effect.gen(function* () {
      const client = yield* register()
      const { verifier, challenge } = pkce()
      const code = yield* authorize(client, challenge)
      // The wrong verifier spends the code
      expect(yield* exchange(client, code, pkce().verifier)).toMatchObject({
        error: 'invalid_grant',
      })
      expect(yield* exchange(client, code, verifier)).toMatchObject({ error: 'invalid_grant' })

      const again = yield* authorize(client, challenge)
      const other = yield* register()
      expect(yield* exchange(other, again, verifier)).toMatchObject({ error: 'invalid_grant' })
      const fresh = yield* authorize(client, challenge)
      expect(
        yield* exchange(client, fresh, verifier, { redirect_uri: 'http://localhost:1/x' })
      ).toMatchObject({ error: 'invalid_grant' })

      const good = yield* authorize(client, challenge)
      const answer = tokens(yield* exchange(client, good, verifier))
      expect(answer).toMatchObject({ token_type: 'Bearer', expires_in: 3600, scope: 'mcp' })
      expect(yield* verify(answer.access_token)).toBe(true)
      expect(yield* verify(answer.access_token, 'https://other.test/mcp')).toBe(false)
      expect(yield* verify(answer.refresh_token)).toBe(false)
      expect(yield* verify('gma_nope')).toBe(false)
      // Used: gone
      expect(yield* exchange(client, good, verifier)).toMatchObject({ error: 'invalid_grant' })
      expect(pkceMatches('short', challenge)).toBe(false)
    })
  )

  it.effect('rotates the refresh token, expires tokens, revokes grants', () =>
    Effect.gen(function* () {
      const oauth = yield* OAuth
      const client = yield* register()
      const { verifier, challenge } = pkce()
      const first = tokens(yield* exchange(client, yield* authorize(client, challenge), verifier))
      const refresh = (token: string, clientId = client.client_id) =>
        oauth.token(
          form({ grant_type: 'refresh_token', refresh_token: token, client_id: clientId })
        )
      expect(yield* refresh(first.refresh_token, 'someone-else')).toMatchObject({
        error: 'invalid_grant',
      })
      const second = tokens(yield* refresh(first.refresh_token))
      expect(second.refresh_token).not.toBe(first.refresh_token)
      // The old one is spent
      expect(yield* refresh(first.refresh_token)).toMatchObject({ error: 'invalid_grant' })

      // An hour later the access token is refused, the refresh token still works
      yield* TestClock.adjust('61 minutes')
      expect(yield* verify(second.access_token)).toBe(false)
      const third = tokens(yield* refresh(second.refresh_token))
      expect(yield* verify(third.access_token)).toBe(true)
      expect((yield* oauth.grants).map((grant) => grant.client_name)).toContain('Claude Code')

      // Revoked by its refresh token: its access token with it
      yield* oauth.revoke(third.refresh_token)
      expect(yield* verify(third.access_token)).toBe(false)
      expect(yield* refresh(third.refresh_token)).toMatchObject({ error: 'invalid_grant' })

      // 30 days without use: the grant is gone
      const fourth = tokens(yield* exchange(client, yield* authorize(client, challenge), verifier))
      yield* TestClock.adjust('31 days')
      expect(yield* refresh(fourth.refresh_token)).toMatchObject({ error: 'invalid_grant' })
    })
  )

  it.effect('revokes one grant from /access, or all of them on a new password', () =>
    Effect.gen(function* () {
      const oauth = yield* OAuth
      yield* oauth.revokeAll
      const client = yield* register()
      const { verifier, challenge } = pkce()
      const a = tokens(yield* exchange(client, yield* authorize(client, challenge), verifier))
      const b = tokens(yield* exchange(client, yield* authorize(client, challenge), verifier))
      const listed = yield* oauth.grants
      expect(listed).toHaveLength(2)
      expect(listed[0]).toMatchObject({ redirect_host: 'localhost:4567' })
      yield* oauth.revokeGrant(listed[0]?.id ?? '')
      expect((yield* verify(a.access_token)) !== (yield* verify(b.access_token))).toBe(true)
      yield* oauth.revokeAll
      expect(yield* verify(a.access_token)).toBe(false)
      expect(yield* verify(b.access_token)).toBe(false)
      expect(yield* oauth.grants).toEqual([])
    })
  )

  it.effect('revokes the grant when a spent refresh token comes back, but in a race', () =>
    Effect.gen(function* () {
      const oauth = yield* OAuth
      const client = yield* register()
      const { verifier, challenge } = pkce()
      const refresh = (token: string) =>
        oauth.token(
          form({ grant_type: 'refresh_token', refresh_token: token, client_id: client.client_id })
        )
      const first = tokens(yield* exchange(client, yield* authorize(client, challenge), verifier))
      const second = tokens(yield* refresh(first.refresh_token))
      // At once: another process of the client refreshing too, the grant stays
      expect(yield* refresh(first.refresh_token)).toMatchObject({ error: 'invalid_grant' })
      expect(yield* verify(second.access_token)).toBe(true)
      // Later: the old token leaked, the grant goes
      yield* TestClock.adjust('1 minute')
      expect(yield* refresh(first.refresh_token)).toMatchObject({ error: 'invalid_grant' })
      expect(yield* verify(second.access_token)).toBe(false)
      expect(yield* refresh(second.refresh_token)).toMatchObject({ error: 'invalid_grant' })
    })
  )

  it.effect('keeps the newest registrations nothing was authorized for, and the young', () =>
    Effect.gen(function* () {
      const oauth = yield* OAuth
      const client = yield* register()
      const { verifier, challenge } = pkce()
      tokens(yield* exchange(client, yield* authorize(client, challenge), verifier))
      const shown = (id: string) =>
        oauth.check(
          {
            response_type: 'code',
            client_id: id,
            redirect_uri: REDIRECT,
            code_challenge: challenge,
            code_challenge_method: 'S256',
          },
          RESOURCE
        )
      const idle = yield* register()
      for (let i = 0; i < 25; i += 1) {
        yield* TestClock.adjust('1 second')
        yield* register()
      }
      // All young: none gone
      expect(yield* shown(idle.client_id)).toMatchObject({ client_id: idle.client_id })
      yield* TestClock.adjust('11 minutes')
      yield* register()
      // Authorized, kept; never authorized, past 10 minutes, 25 newer ones: gone
      expect(yield* shown(client.client_id)).toMatchObject({ client_id: client.client_id })
      expect(yield* shown(idle.client_id)).toBe('client')
    })
  )
})
