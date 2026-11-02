import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { link, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { Clock, Config, Context, Effect, Layer, Predicate, Semaphore } from 'effect'

import { MIN_PASSWORD_LENGTH } from './password-length.ts'
import { hashPassword, verifyPassword } from './password.ts'

// The single user's password: the MCP's bearer token, and the web app's login, which sets a signed
// session cookie (30 days). Chosen in the web app (/setup) on the first visit, changed on
// /password; only its scrypt hash is kept (see password.ts), in a file of its own beside the
// Garmin session (PASSWORD_PATH, 0600 in a 0700 directory), never in SQLite nor data/.

export const SESSION_COOKIE = 'garmin_web'
const SESSION_DAYS = 30
const SESSION_MS = SESSION_DAYS * 86_400_000

// Wrong passwords, per minute: 10 per client, 60 in all; and 2 checks at a time (scrypt takes
// 100 ms and 32 MiB of the thread pool each). Past that the check is refused without running.
const WINDOW_MS = 60_000
const PER_CLIENT = 10
const IN_ALL = 60
const AT_ONCE = 2

export type Verdict = 'ok' | 'wrong' | 'throttled'

const isCode = (error: unknown, code: string) =>
  Predicate.hasProperty(error, 'code') && error.code === code

export type Session = { readonly value: string; readonly maxAge: number }
// Why a new password was refused
export type Refusal = 'short' | 'exists' | 'wrong' | 'throttled'

// The times of the last minute's wrong passwords, per client and in all ('')
export const failureLog = () => {
  const times = new Map<string, Array<number>>()
  const recent = (key: string, now: number) =>
    (times.get(key) ?? []).filter((time) => time > now - WINDOW_MS)
  return {
    blocked: (client: string, now: number) =>
      recent(client, now).length >= PER_CLIENT || recent('', now).length >= IN_ALL,
    record: (client: string, now: number) => {
      for (const key of [client, '']) times.set(key, [...recent(key, now), now])
      // The clients without a failure in the last minute are forgotten
      for (const [key, list] of times) {
        if (list.every((time) => time <= now - WINDOW_MS)) times.delete(key)
      }
    },
    size: () => times.size,
  }
}

export class Auth extends Context.Service<
  Auth,
  {
    // A wrong password answers after a second; too many from the client (see clientOf), or in
    // all, and the check is throttled
    readonly verify: (password: string, client: string) => Effect.Effect<Verdict>
    // The MCP's bearer token, the password: the last one accepted is remembered, so each call
    // does not pay scrypt again (nor the throttle)
    readonly verifyBearer: (token: string, client: string) => Effect.Effect<Verdict>
    // The web session: `<expiry ms>.<HMAC>`, keyed from the password's hash (a new password
    // logs every browser out)
    readonly issueSession: Effect.Effect<Session>
    readonly verifySession: (value: string) => Effect.Effect<boolean>
    // Logs every browser out (the MCP's token stays): the sessions issued until now are refused
    readonly logout: Effect.Effect<void>
    // Whether a password was chosen; until then, the app only offers /setup
    readonly hasPassword: Effect.Effect<boolean>
    // The first password, only while there is none (the first one to answer wins: open /setup
    // right after the deploy), and a session for the browser that chose it
    readonly setup: (password: string) => Effect.Effect<Session | Refusal>
    // A new password for the current one (throttled like a login): every other browser and the
    // MCP's remembered token are logged out
    readonly change: (
      current: string,
      next: string,
      client: string
    ) => Effect.Effect<Session | Refusal>
  }
>()('garmin/Auth') {
  static readonly layer = Layer.effect(
    Auth,
    Effect.gen(function* () {
      const path = yield* Config.String('PASSWORD_PATH').pipe(
        Config.withDefault(join('.tokens', 'password'))
      )
      // No file: no password yet. Any other error (a mis-owned volume) stops the app rather than
      // offering /setup again.
      let hash = yield* Effect.promise(() =>
        readFile(path, 'utf8').then(
          (text) => text.trim() || undefined,
          (error: unknown) => {
            if (isCode(error, 'ENOENT')) return undefined
            throw error
          }
        )
      )
      const digest = (token: string) => createHash('sha256').update(token).digest()
      const keyOf = (of: string) =>
        createHash('sha256').update(`garmin web session\0${of}`).digest()
      // When the browsers were last logged out (ms), kept beside the password: a session issued
      // until then (its expiry less SESSION_MS) is refused, even a copy of its cookie
      const loggedOutPath = join(dirname(path), 'logged-out')
      let loggedOutAt = yield* Effect.promise(() =>
        readFile(loggedOutPath, 'utf8').then(
          (text) => Number(text.trim()) || Number.NEGATIVE_INFINITY,
          (error: unknown) => {
            if (isCode(error, 'ENOENT')) return Number.NEGATIVE_INFINITY
            throw error
          }
        )
      )
      let sessionKey = hash === undefined ? undefined : keyOf(hash)
      const sign = (key: Buffer, expiry: string) =>
        createHmac('sha256', key).update(expiry).digest('base64url')
      let accepted: Buffer | undefined
      const adopt = (next: string) => {
        hash = next
        sessionKey = keyOf(next)
        accepted = undefined
      }
      // Beside the target then moved over it: never half a hash. `link` refuses an existing
      // target, so only one first password can win.
      const store = (next: string, { replace }: { readonly replace: boolean }) =>
        Effect.promise(async () => {
          await mkdir(dirname(path), { recursive: true, mode: 0o700 })
          const partial = join(dirname(path), `.password.${randomUUID()}`)
          await writeFile(partial, `${next}\n`, { mode: 0o600 })
          try {
            if (replace) {
              await rename(partial, path)
              return true
            }
            return await link(partial, path).then(
              () => true,
              (error: unknown) => {
                if (isCode(error, 'EEXIST')) return false
                throw error
              }
            )
          } finally {
            await rm(partial, { force: true })
          }
        })
      const failures = failureLog()
      let checking = 0
      // One setup or change at a time: the file and the memory stay the same password
      const writing = yield* Semaphore.make(1)

      const verify = Effect.fn('Auth.verify')(function* (password: string, client: string) {
        const now = yield* Clock.currentTimeMillis
        if (failures.blocked(client, now) || checking >= AT_ONCE) {
          return 'throttled' satisfies Verdict
        }
        const current = hash
        if (current === undefined) return 'wrong' satisfies Verdict
        checking += 1
        const ok = yield* Effect.promise(() => verifyPassword(current, password)).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              checking -= 1
            })
          )
        )
        // Changed meanwhile: the password checked is no longer the one
        if (ok) return hash === current ? ('ok' satisfies Verdict) : ('wrong' satisfies Verdict)
        failures.record(client, now)
        yield* Effect.sleep('1 second')
        return 'wrong' satisfies Verdict
      })

      // No password yet: no session either (an empty key would sign anything)
      const issueSession = Effect.map(Clock.currentTimeMillis, (now): Session => {
        const expiry = String(now + SESSION_MS)
        const key = sessionKey ?? keyOf(randomUUID())
        return { value: `${expiry}.${sign(key, expiry)}`, maxAge: SESSION_DAYS * 86_400 }
      })

      const setup = Effect.fn('Auth.setup')(function* (password: string) {
        if (hash !== undefined) return 'exists' satisfies Refusal
        if (password.length < MIN_PASSWORD_LENGTH) return 'short' satisfies Refusal
        const next = yield* Effect.promise(() => hashPassword(password))
        if (!(yield* store(next, { replace: false }))) {
          // Chosen meanwhile by another process: that one stands
          const other = yield* Effect.promise(() => readFile(path, 'utf8').catch(() => ''))
          if (other.trim() !== '') adopt(other.trim())
          return 'exists' satisfies Refusal
        }
        adopt(next)
        return yield* issueSession
      }, writing.withPermits(1))

      const change = Effect.fn('Auth.change')(function* (
        current: string,
        next: string,
        client: string
      ) {
        const verdict = yield* verify(current, client)
        if (verdict !== 'ok') return verdict
        if (next.length < MIN_PASSWORD_LENGTH) return 'short' satisfies Refusal
        const stored = yield* Effect.promise(() => hashPassword(next))
        yield* store(stored, { replace: true })
        adopt(stored)
        return yield* issueSession
      }, writing.withPermits(1))

      return {
        verify,
        hasPassword: Effect.sync(() => hash !== undefined),
        setup,
        change,
        verifyBearer: (token, client) =>
          accepted !== undefined && timingSafeEqual(accepted, digest(token))
            ? Effect.succeed<Verdict>('ok')
            : verify(token, client).pipe(
                Effect.tap((verdict) =>
                  Effect.sync(() => {
                    if (verdict === 'ok') accepted = digest(token)
                  })
                )
              ),
        issueSession,
        verifySession: (value) =>
          Effect.map(Clock.currentTimeMillis, (now) => {
            const [expiry, signature] = value.split('.')
            if (
              sessionKey === undefined ||
              expiry === undefined ||
              signature === undefined ||
              !/^\d+$/u.test(expiry)
            ) {
              return false
            }
            const expected = Buffer.from(sign(sessionKey, expiry))
            const given = Buffer.from(signature)
            return (
              expected.length === given.length &&
              timingSafeEqual(expected, given) &&
              Number(expiry) > now &&
              Number(expiry) - SESSION_MS > loggedOutAt
            )
          }),
        logout: Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis
          yield* Effect.promise(async () => {
            await mkdir(dirname(path), { recursive: true, mode: 0o700 })
            const partial = join(dirname(path), `.logged-out.${randomUUID()}`)
            await writeFile(partial, `${now}\n`, { mode: 0o600 })
            await rename(partial, loggedOutPath)
          })
          loggedOutAt = now
        }),
      }
    })
  )
}

const text = (body: string, status: number, headers: Record<string, string> = {}) =>
  new Response(body, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', ...headers },
  })

export const cookieOf = (request: Request, name: string) => {
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const [key, ...value] = part.trim().split('=')
    if (key === name) return value.join('=')
  }
  return undefined
}

// Who is guessing: the address the reverse proxy saw, the last of X-Forwarded-For, which a
// client cannot forge; without a proxy, one bucket for all
export const clientOf = (request: Request) => {
  const last = (request.headers.get('x-forwarded-for') ?? '').split(',').at(-1)?.trim()
  return last === undefined || last === '' ? 'direct' : last
}

// The session cookie is Secure but on http://localhost (the app behind a TLS proxy sees http)
export const secureCookie = (request: Request) =>
  ['localhost', '127.0.0.1', '[::1]'].includes(new URL(request.url).hostname) ? '' : '; Secure'

// The session cookie for a browser
export const sessionCookie = (request: Request, session: Session) =>
  `${SESSION_COOKIE}=${session.value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${session.maxAge}${secureCookie(request)}`

// A small form's fields (a password or two and a path), or 413 past MAX_FORM bytes, unread
const MAX_FORM = 4096
export const readForm = async (request: Request) => {
  const length = Number(request.headers.get('content-length'))
  if (!Number.isInteger(length) || length <= 0 || length > MAX_FORM) {
    return new Response('Payload too large\n', { status: 413 })
  }
  const form = await request.formData()
  return (name: string) => {
    const value = form.get(name)
    return typeof value === 'string' ? value : null
  }
}

export const seeOther = (location: string, headers: Record<string, string> = {}) =>
  new Response(null, { status: 303, headers: { location, ...headers } })

// Where to go back after the login: a path of this site only. Printable ASCII only (a browser
// drops a tab, so `/<tab>/evil.test` would be `//evil.test`), and what it resolves to stays here.
const HERE = 'http://garmin.invalid'
export const safeNext = (next: string | null | undefined) => {
  if (typeof next !== 'string' || !/^\/[\u0021-\u007E]*$/u.test(next)) return '/'
  const url = new URL(next, HERE)
  // `/..//evil.test` resolves to the path `//evil.test`: another site again
  const path = `${url.pathname}${url.search}${url.hash}`
  return url.origin === HERE && /^\/(?![/\\])/u.test(path) ? path : '/'
}

// A state-changing request from another site (CSRF): browsers say where it comes from with
// Sec-Fetch-Site, older ones with Origin. Without either, not a browser: it needs the cookie.
const crossSite = (request: Request, url: URL) => {
  const site = request.headers.get('sec-fetch-site')
  if (site !== null) return site !== 'same-origin' && site !== 'none'
  const origin = request.headers.get('origin')
  if (origin === null) return false
  try {
    return new URL(origin).host !== url.host
  } catch {
    return true
  }
}

// The health check is open; the MCP takes the password as a bearer token; a POST (or any other
// method that changes something) from another site is refused; the login page, its form and the
// built assets are open; everything else (pages, server functions) needs the web session, a page
// redirecting to the login. Undefined lets the request through.
export const gate = async (
  request: Request,
  {
    hasPassword,
    verifyBearer,
    verifySession,
  }: {
    readonly hasPassword: () => Promise<boolean>
    readonly verifyBearer: (token: string, client: string) => Promise<Verdict>
    readonly verifySession: (value: string) => Promise<boolean>
  }
): Promise<Response | undefined> => {
  const url = new URL(request.url)
  const path = url.pathname
  const page =
    request.method === 'GET' && (request.headers.get('accept') ?? '').includes('text/html')
  const redirect = (location: string) => new Response(null, { status: 302, headers: { location } })
  if (path === '/healthz') return undefined
  // As the router matches it: any case, trailing slash
  if (/^\/mcp\/?$/iu.test(path)) {
    const token = /^Bearer (.+)$/iu.exec(request.headers.get('authorization') ?? '')?.[1]
    const verdict =
      token === undefined || !(await hasPassword())
        ? 'wrong'
        : await verifyBearer(token, clientOf(request))
    if (verdict === 'ok') return undefined
    return verdict === 'throttled'
      ? text('Too many wrong passwords: try again in a minute\n', 429, { 'retry-after': '60' })
      : text('Unauthorized\n', 401, { 'www-authenticate': 'Bearer' })
  }
  if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && crossSite(request, url)) {
    return text('Forbidden: a request from another site\n', 403)
  }
  if (path.startsWith('/assets/')) return undefined
  const setup = path === '/setup' || path === '/auth/setup'
  // No password yet: only the page that chooses it
  if (!(await hasPassword())) {
    if (setup) return undefined
    return page ? redirect('/setup') : text('No password yet: choose it at /setup\n', 401)
  }
  if (setup) return page ? redirect('/login') : text('The password is already chosen\n', 403)
  if (path === '/login' || path === '/auth/login') return undefined
  const session = cookieOf(request, SESSION_COOKIE)
  if (session !== undefined && (await verifySession(session))) return undefined
  if (page) return redirect(`/login?next=${encodeURIComponent(path + url.search)}`)
  return text('Unauthorized: log in at /login\n', 401)
}
