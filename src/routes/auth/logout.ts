import { createFileRoute } from '@tanstack/react-router'

import { secureCookie, SESSION_COOKIE } from '#src/auth.ts'

// Forgets this browser's session
export const Route = createFileRoute('/auth/logout')({
  server: {
    handlers: {
      POST: ({ request }) =>
        new Response(null, {
          status: 303,
          headers: {
            location: '/login',
            'set-cookie': `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secureCookie(request)}`,
          },
        }),
    },
  },
})
