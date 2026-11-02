import { createFileRoute } from '@tanstack/react-router'
import { Effect } from 'effect'

import { Auth, clientOf, readForm, seeOther, sessionCookie } from '#src/auth.ts'
import { OAuth } from '#src/oauth/oauth.ts'
import { runtime } from '#src/server/runtime.ts'

// A new password (routes/password.tsx), for the current one: this browser keeps a session, every
// other one and the MCP's clients must log in again (the password's, or OAuth's: every grant is
// revoked)
export const Route = createFileRoute('/auth/password')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const field = await readForm(request)
        if (field instanceof Response) return field
        const next = field('password') ?? ''
        if (next !== field('again')) return seeOther('/password?error=mismatch')
        const outcome = await runtime.runPromise(
          Auth.use((auth) => auth.change(field('current') ?? '', next, clientOf(request))).pipe(
            // Changed: every OAuth grant goes too
            Effect.tap((changed) =>
              typeof changed === 'string' ? Effect.void : OAuth.use((oauth) => oauth.revokeAll)
            )
          )
        )
        if (typeof outcome === 'string') return seeOther(`/password?error=${outcome}`)
        return seeOther('/password?changed=1', { 'set-cookie': sessionCookie(request, outcome) })
      },
    },
  },
})
