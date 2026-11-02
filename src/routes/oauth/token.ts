import { createFileRoute } from '@tanstack/react-router'

import { readForm } from '#src/auth.ts'
import { json } from '#src/oauth/http.ts'
import { OAuth } from '#src/oauth/oauth.ts'
import { runtime } from '#src/server/runtime.ts'

// The token endpoint: a code (with its PKCE verifier) or a refresh token for new tokens
export const Route = createFileRoute('/oauth/token')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const field = await readForm(request)
        if (field instanceof Response) return field
        const answer = await runtime.runPromise(OAuth.use((oauth) => oauth.token(field)))
        if (!('error' in answer)) return json(answer)
        return json(answer, answer.error === 'invalid_client' ? 401 : 400)
      },
    },
  },
})
