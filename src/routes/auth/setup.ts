import { createFileRoute } from '@tanstack/react-router'

import { Auth, readForm, seeOther, sessionCookie } from '#src/auth.ts'
import { runtime } from '#src/server/runtime.ts'

// The first password (routes/setup.tsx), only while there is none (see auth.ts's gate): then the
// session, and on to connecting the Garmin account
export const Route = createFileRoute('/auth/setup')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const field = await readForm(request)
        if (field instanceof Response) return field
        const password = field('password') ?? ''
        if (password !== field('again')) return seeOther('/setup?error=mismatch')
        const outcome = await runtime.runPromise(Auth.use((auth) => auth.setup(password)))
        if (outcome === 'exists') return seeOther('/login')
        if (typeof outcome === 'string') return seeOther(`/setup?error=${outcome}`)
        return seeOther('/garmin', { 'set-cookie': sessionCookie(request, outcome) })
      },
    },
  },
})
