import { createFileRoute } from '@tanstack/react-router'
import { Effect } from 'effect'

import { Auth, clientOf, readForm, safeNext, seeOther, sessionCookie } from '#src/auth.ts'
import { runtime } from '#src/server/runtime.ts'

// The login form's POST (routes/login.tsx): the password, then the session cookie and back to
// where the visitor was going
export const Route = createFileRoute('/auth/login')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const field = await readForm(request)
        if (field instanceof Response) return field
        const password = field('password')
        const next = safeNext(field('next'))
        const outcome = await runtime.runPromise(
          Auth.use((auth) =>
            Effect.gen(function* () {
              if (password === null) return 'wrong' as const
              const verdict = yield* auth.verify(password, clientOf(request))
              return verdict === 'ok' ? yield* auth.issueSession : verdict
            })
          )
        )
        if (typeof outcome === 'string') {
          const error = outcome === 'throttled' ? 'busy' : 'wrong'
          return seeOther(`/login?error=${error}&next=${encodeURIComponent(next)}`)
        }
        return seeOther(next, { 'set-cookie': sessionCookie(request, outcome) })
      },
    },
  },
})
