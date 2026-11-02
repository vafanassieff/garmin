import { createFileRoute } from '@tanstack/react-router'

import { clientOf } from '#src/auth.ts'
import { json, readJson } from '#src/oauth/http.ts'
import { OAuth } from '#src/oauth/oauth.ts'
import { runtime } from '#src/server/runtime.ts'

// RFC 7591: an MCP client registers itself (open, as clients expect, throttled per address; see
// oauth/oauth.ts)
export const Route = createFileRoute('/oauth/register')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const body = await readJson(request)
        const answer = await runtime.runPromise(
          OAuth.use((oauth) => oauth.register(body, clientOf(request)))
        )
        if (answer === 'throttled') {
          return json({ error: 'slow_down', error_description: 'Too many registrations.' }, 429)
        }
        return 'error' in answer ? json(answer, 400) : json(answer, 201)
      },
    },
  },
})
