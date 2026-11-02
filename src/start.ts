import { createMiddleware, createStart } from '@tanstack/react-start'

import { gate } from './auth.ts'
import { hasPassword, verifyBearer, verifySession } from './server/auth.ts'

// On every answer: not framed by another site (clickjacking on the Garmin login form), no MIME
// sniffing, no URL sent to other sites, HTTPS only once seen over HTTPS, and pages of health data
// kept out of caches (unless the answer says otherwise)
const HEADERS: Record<string, string> = {
  'content-security-policy':
    "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'",
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'same-origin',
  'strict-transport-security': 'max-age=31536000',
  'cache-control': 'private, no-store',
}

// In place: TanStack marks its own responses (a redirect's `options`), which a copy would lose.
// A response with immutable headers (from fetch) is copied, its marks with it.
const secured = (response: Response) => {
  const missing = Object.entries(HEADERS).filter(([name]) => !response.headers.has(name))
  try {
    for (const [name, value] of missing) response.headers.set(name, value)
    return response
  } catch {
    const headers = new Headers(response.headers)
    for (const [name, value] of missing) headers.set(name, value)
    return Object.assign(
      new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      }),
      Object.fromEntries(Object.entries(response))
    )
  }
}

// The password in front of everything (see auth.ts)
const auth = createMiddleware().server(async ({ request, next }) =>
  secured(
    (await gate(request, { hasPassword, verifyBearer, verifySession })) ?? (await next()).response
  )
)

export const startInstance = createStart(() => ({ requestMiddleware: [auth] }))
