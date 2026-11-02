import { createFileRoute } from '@tanstack/react-router'

import { publicOrigin, readForm } from '#src/auth.ts'
import { authorizeRequest, refusedPage } from '#src/oauth/consent.ts'
import { backTo } from '#src/oauth/http.ts'
import { OAuth } from '#src/oauth/oauth.ts'
import { runtime } from '#src/server/runtime.ts'

// The consent form's POST (routes/authorize.ts), behind the web session and from this site only
// (see auth.ts's gate): the request checked again, then back to the client with a code, or
// access_denied
export const Route = createFileRoute('/oauth/authorize')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const field = await readForm(request)
        if (field instanceof Response) return field
        const origin = publicOrigin(request)
        const allowed = field('decision') === 'allow'
        const answer = await runtime.runPromise(
          OAuth.use((oauth) =>
            oauth.answer(authorizeRequest(field), `${origin}/mcp`, origin, allowed)
          )
        )
        return typeof answer === 'string' ? refusedPage(answer) : backTo(answer.location, allowed)
      },
    },
  },
})
