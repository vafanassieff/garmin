import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { expect, layer } from '@effect/vitest'
import { Config, ConfigProvider, Effect, Layer } from 'effect'
import { describe, it } from 'vitest'

import { Auth, clientOf, failureLog, gate, safeNext, secureCookie, type Verdict } from './auth.ts'

const PASSWORD = 'correct horse battery'

// The password's file in a fresh directory, removed with the layer
const passwordDir = Layer.unwrap(
  Effect.acquireRelease(
    Effect.sync(() => mkdtempSync(join(tmpdir(), 'garmin-auth-'))),
    (directory) => Effect.sync(() => rmSync(directory, { recursive: true, force: true }))
  ).pipe(
    Effect.map((directory) =>
      ConfigProvider.layer(
        ConfigProvider.fromUnknown({ PASSWORD_PATH: join(directory, 'session', 'password') })
      )
    )
  )
)

// The real clock: a wrong password's second is waited
layer(Auth.layer.pipe(Layer.provideMerge(passwordDir)), { excludeTestServices: true })(
  'Auth',
  (it) => {
    it.effect('takes a first password once, then as bearer token', () =>
      Effect.gen(function* () {
        const auth = yield* Auth
        expect(yield* auth.hasPassword).toBe(false)
        expect(yield* auth.verifyBearer(PASSWORD, 'a')).toBe('wrong')
        expect(yield* auth.setup('too short')).toBe('short')
        const session = yield* auth.setup(PASSWORD)
        expect(session).toMatchObject({ maxAge: 30 * 86_400 })
        expect(yield* auth.hasPassword).toBe(true)
        expect(yield* auth.setup('someone else first')).toBe('exists')
        expect(yield* auth.verifyBearer(PASSWORD, 'a')).toBe('ok')
        expect(yield* auth.verifyBearer(PASSWORD, 'a')).toBe('ok')
        const start = performance.now()
        expect(yield* auth.verifyBearer('Correct horse battery', 'a')).toBe('wrong')
        expect(performance.now() - start).toBeGreaterThanOrEqual(1000)
      })
    )

    it.effect('checks 2 passwords at a time, refuses a third meanwhile', () =>
      Effect.gen(function* () {
        const auth = yield* Auth
        const verdicts = yield* Effect.all(
          [auth.verify('nope', 'b'), auth.verify('nope', 'c'), auth.verify(PASSWORD, 'd')],
          { concurrency: 'unbounded' }
        )
        expect(verdicts).toEqual(['wrong', 'wrong', 'throttled'])
        // The remembered bearer is not throttled
        expect(yield* auth.verifyBearer(PASSWORD, 'b')).toBe('ok')
      })
    )

    it.effect('signs the web session, and refuses one altered', () =>
      Effect.gen(function* () {
        const auth = yield* Auth
        const { value, maxAge } = yield* auth.issueSession
        expect(maxAge).toBe(30 * 86_400)
        expect(yield* auth.verifySession(value)).toBe(true)
        const [expiry, signature] = value.split('.')
        expect(yield* auth.verifySession(`${Number(expiry) + 1}.${signature}`)).toBe(false)
        expect(yield* auth.verifySession(`${expiry}.${signature?.slice(1)}`)).toBe(false)
        expect(yield* auth.verifySession('garbage')).toBe(false)
        expect(yield* auth.verifySession(`${value}.more`)).toBe(false)
      })
    )

    it.effect('logs every browser out, for good', () =>
      Effect.gen(function* () {
        const auth = yield* Auth
        const before = yield* auth.issueSession
        yield* auth.logout
        yield* Effect.sleep('5 millis')
        const after = yield* auth.issueSession
        expect(yield* auth.verifySession(before.value)).toBe(false)
        expect(yield* auth.verifySession(after.value)).toBe(true)
        // Kept across a restart, 0600
        const again = (value: string) =>
          Auth.use((fresh) => fresh.verifySession(value)).pipe(Effect.provide(Auth.layer))
        expect(yield* again(before.value)).toBe(false)
        expect(yield* again(after.value)).toBe(true)
        const { PASSWORD_PATH } = yield* Config.all({
          PASSWORD_PATH: Config.String('PASSWORD_PATH'),
        })
        expect(statSync(join(dirname(PASSWORD_PATH), 'logged-out')).mode & 0o777).toBe(0o600)
      })
    )

    it.effect('changes the password for the current one, logging the others out', () =>
      Effect.gen(function* () {
        const auth = yield* Auth
        const before = yield* auth.issueSession
        expect(yield* auth.change('not it', 'a brand new password', 'e')).toBe('wrong')
        expect(yield* auth.change(PASSWORD, 'short', 'e')).toBe('short')
        const after = yield* auth.change(PASSWORD, 'a brand new password', 'e')
        if (typeof after === 'string') throw new Error(after)
        expect(yield* auth.verifySession(before.value)).toBe(false)
        expect(yield* auth.verifySession(after.value)).toBe(true)
        expect(yield* auth.verifyBearer(PASSWORD, 'e')).toBe('wrong')
        expect(yield* auth.verifyBearer('a brand new password', 'e')).toBe('ok')
      })
    )
  }
)

describe('the password file', () => {
  it('keeps only the hash, 0600 in a 0700 directory, read again after a restart', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'garmin-auth-'))
    const path = join(directory, 'session', 'password')
    // Each run builds the service again: a new process over the same file
    const run = <A>(effect: Effect.Effect<A, never, Auth>) =>
      Effect.runPromise(
        effect.pipe(
          Effect.provide(
            Auth.layer.pipe(
              Layer.provide(
                ConfigProvider.layer(ConfigProvider.fromUnknown({ PASSWORD_PATH: path }))
              )
            )
          )
        )
      )
    try {
      await run(Auth.use((auth) => auth.setup(PASSWORD)))
      expect(statSync(path).mode & 0o777).toBe(0o600)
      expect(statSync(dirname(path)).mode & 0o777).toBe(0o700)
      const stored = readFileSync(path, 'utf8')
      expect(stored).toMatch(/^scrypt\$/u)
      expect(stored).not.toContain(PASSWORD)
      expect(await run(Auth.use((auth) => auth.hasPassword))).toBe(true)
      expect(await run(Auth.use((auth) => auth.setup('another password here')))).toBe('exists')
      expect(await run(Auth.use((auth) => auth.verify(PASSWORD, 'a')))).toBe('ok')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

describe('gate', () => {
  const verifyBearer = (token: string) =>
    Promise.resolve<Verdict>(token === 'demo' ? 'ok' : token === 'many' ? 'throttled' : 'wrong')
  const verifySession = (value: string) => Promise.resolve(value === 'ok')
  let chosen = true
  const hasPassword = () => Promise.resolve(chosen)
  const answer = (path: string, headers: Record<string, string> = {}, method = 'GET') =>
    gate(new Request(`https://garmin.test${path}`, { headers, method }), {
      hasPassword,
      verifyBearer,
      verifySession,
    })
  const status = async (path: string, headers: Record<string, string> = {}, method = 'GET') =>
    (await answer(path, headers, method))?.status

  it('opens the health check and the login, the MCP to the password', async () => {
    expect(await status('/healthz')).toBeUndefined()
    expect(await status('/login')).toBeUndefined()
    expect(await status('/auth/login', {}, 'POST')).toBeUndefined()
    expect(await status('/assets/index.js')).toBeUndefined()
    expect(await status('/mcp')).toBe(401)
    const refused = await answer('/mcp', { authorization: 'Bearer nope' })
    expect(refused?.status).toBe(401)
    // RFC 9728: where to find the OAuth server
    expect(refused?.headers.get('www-authenticate')).toBe(
      'Bearer error="invalid_token", resource_metadata="https://garmin.test/.well-known/oauth-protected-resource/mcp", scope="mcp"'
    )
    expect((await answer('/mcp'))?.headers.get('www-authenticate')).toMatch(
      /^Bearer resource_metadata="/u
    )
    expect(await status('/mcp', { authorization: 'Bearer demo' })).toBeUndefined()
    expect(await status('/MCP/', { authorization: 'bearer demo' })).toBeUndefined()
    // The session cookie does not open the MCP
    expect(await status('/mcp', { cookie: 'garmin_web=ok' })).toBe(401)
    const throttled = await answer('/mcp', { authorization: 'Bearer many' })
    expect(throttled?.status).toBe(429)
    expect(throttled?.headers.get('retry-after')).toBe('60')
  })

  it('opens the OAuth endpoints, not the consent', async () => {
    for (const path of [
      '/.well-known/oauth-protected-resource/mcp',
      '/.well-known/oauth-authorization-server',
    ]) {
      expect(await status(path), path).toBeUndefined()
    }
    for (const path of ['/oauth/register', '/oauth/token', '/oauth/revoke']) {
      expect(await status(path, {}, 'POST'), path).toBeUndefined()
    }
    // The consent needs the session, and its form this site
    expect(
      (await answer('/authorize?client_id=x', { accept: 'text/html' }))?.headers.get('location')
    ).toBe('/login?next=%2Fauthorize%3Fclient_id%3Dx')
    expect(await status('/oauth/authorize', {}, 'POST')).toBe(401)
    expect(
      await status(
        '/oauth/authorize',
        { cookie: 'garmin_web=ok', 'sec-fetch-site': 'cross-site' },
        'POST'
      )
    ).toBe(403)
    expect(
      await status(
        '/oauth/authorize',
        { cookie: 'garmin_web=ok', 'sec-fetch-site': 'same-origin' },
        'POST'
      )
    ).toBeUndefined()
    // Not before a password exists
    chosen = false
    try {
      expect(await status('/oauth/register', {}, 'POST')).toBe(401)
    } finally {
      chosen = true
    }
  })

  it('offers only /setup until a password is chosen, never after', async () => {
    chosen = false
    try {
      const page = await answer('/sleep', { accept: 'text/html' })
      expect(page?.headers.get('location')).toBe('/setup')
      expect((await answer('/login', { accept: 'text/html' }))?.headers.get('location')).toBe(
        '/setup'
      )
      expect(await status('/setup', { accept: 'text/html' })).toBeUndefined()
      expect(
        await status('/auth/setup', { 'sec-fetch-site': 'same-origin' }, 'POST')
      ).toBeUndefined()
      expect(await status('/_serverFn/x', {}, 'POST')).toBe(401)
      expect(await status('/mcp', { authorization: 'Bearer demo' })).toBe(401)
      // Even before a password: not from another site
      expect(await status('/auth/setup', { 'sec-fetch-site': 'cross-site' }, 'POST')).toBe(403)
      expect(await status('/healthz')).toBeUndefined()
    } finally {
      chosen = true
    }
    const setup = await answer('/setup', { accept: 'text/html', cookie: 'garmin_web=ok' })
    expect(setup?.headers.get('location')).toBe('/login')
    expect(await status('/auth/setup', { cookie: 'garmin_web=ok' }, 'POST')).toBe(403)
  })

  it('refuses a POST from another site, even with the session', async () => {
    const session = { cookie: 'garmin_web=ok' }
    expect(
      await status('/_serverFn/x', { ...session, 'sec-fetch-site': 'cross-site' }, 'POST')
    ).toBe(403)
    expect(
      await status('/_serverFn/x', { ...session, 'sec-fetch-site': 'same-site' }, 'POST')
    ).toBe(403)
    expect(await status('/auth/logout', { 'sec-fetch-site': 'cross-site' }, 'POST')).toBe(403)
    expect(await status('/auth/login', { origin: 'https://evil.test' }, 'POST')).toBe(403)
    expect(await status('/auth/login', { origin: 'null' }, 'POST')).toBe(403)
    expect(
      await status('/_serverFn/x', { ...session, 'sec-fetch-site': 'same-origin' }, 'POST')
    ).toBeUndefined()
    expect(
      await status('/_serverFn/x', { ...session, origin: 'https://garmin.test' }, 'POST')
    ).toBeUndefined()
    // A link from another site is a GET: it still opens the page
    expect(
      await status('/', { ...session, accept: 'text/html', 'sec-fetch-site': 'cross-site' })
    ).toBeUndefined()
  })

  it('sends a page without the session to the login, refuses anything else', async () => {
    const page = await answer('/garmin?x=1', { accept: 'text/html' })
    expect(page?.status).toBe(302)
    expect(page?.headers.get('location')).toBe('/login?next=%2Fgarmin%3Fx%3D1')
    expect(await status('/_serverFn/x', {}, 'POST')).toBe(401)
    expect(await status('/', { cookie: 'garmin_web=nope', accept: 'text/html' })).toBe(302)
    expect(await status('/', { cookie: 'a=b; garmin_web=ok', accept: 'text/html' })).toBeUndefined()
    expect(await status('/_serverFn/x', { cookie: 'garmin_web=ok' }, 'POST')).toBeUndefined()
  })

  it('only goes back to a path of this site', () => {
    expect(safeNext('/garmin')).toBe('/garmin')
    expect(safeNext('//evil.test')).toBe('/')
    expect(safeNext('/\\evil.test')).toBe('/')
    expect(safeNext('https://evil.test')).toBe('/')
    expect(safeNext(null)).toBe('/')
    // A browser drops the tab and the newline: //evil.test
    expect(safeNext('/\t/evil.test')).toBe('/')
    expect(safeNext('/\n/evil.test')).toBe('/')
    // Dot segments that leave `//`
    expect(safeNext('/..//evil.test')).toBe('/')
    expect(safeNext('/%2e%2e//evil.test')).toBe('/')
    expect(safeNext('/.//evil.test')).toBe('/')
    expect(safeNext('/sleep?days=90')).toBe('/sleep?days=90')
  })

  it('throttles a client after 10 wrong passwords a minute, everyone after 60', () => {
    const log = failureLog()
    for (let index = 0; index < 10; index += 1) {
      expect(log.blocked('a', index)).toBe(false)
      log.record('a', index)
    }
    expect(log.blocked('a', 10)).toBe(true)
    expect(log.blocked('b', 10)).toBe(false)
    // A minute later
    expect(log.blocked('a', 60_010)).toBe(false)
    for (let index = 0; index < 60; index += 1) log.record(`c${index}`, 70_000)
    expect(log.blocked('d', 70_001)).toBe(true)
    // The old clients are forgotten
    log.record('e', 200_000)
    expect(log.size()).toBe(2)
  })

  it('reads the client from the proxy, the cookie Secure but on localhost', () => {
    const request = (url: string, headers: Record<string, string> = {}) =>
      new Request(url, { headers })
    expect(clientOf(request('http://x/', { 'x-forwarded-for': '6.6.6.6, 1.2.3.4' }))).toBe(
      '1.2.3.4'
    )
    expect(clientOf(request('http://x/'))).toBe('direct')
    // Behind the TLS proxy the app sees http
    expect(secureCookie(request('http://garmin.example/auth/login'))).toBe('; Secure')
    expect(secureCookie(request('http://localhost:3000/auth/login'))).toBe('')
  })
})
