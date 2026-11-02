import { createFileRoute } from '@tanstack/react-router'

import { readForm } from '#src/auth.ts'
import { OAuth } from '#src/oauth/oauth.ts'
import { runtime } from '#src/server/runtime.ts'

// RFC 7009: a client gives back its token; the grant goes with it. Always 200.
export const Route = createFileRoute('/oauth/revoke')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const field = await readForm(request)
        if (field instanceof Response) return field
        const token = field('token')
        if (token !== null) await runtime.runPromise(OAuth.use((oauth) => oauth.revoke(token)))
        return new Response(null, { status: 200 })
      },
    },
  },
})
