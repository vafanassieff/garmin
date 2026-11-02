import { createFileRoute } from '@tanstack/react-router'

import { secureCookie, SESSION_COOKIE } from '#src/auth.ts'
import { logout } from '#src/server/auth.ts'

// Logs every browser out (behind the gate: only with a session), and forgets this one's cookie
export const Route = createFileRoute('/auth/logout')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        await logout()
        return new Response(null, {
          status: 303,
          headers: {
            location: '/login',
            'set-cookie': `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secureCookie(request)}`,
          },
        })
      },
    },
  },
})
