import { createFileRoute } from '@tanstack/react-router'

import { publicOrigin } from '#src/auth.ts'
import { authorizeRequest, consentPage, refusedPage } from '#src/oauth/consent.ts'
import { OAuth } from '#src/oauth/oauth.ts'
import { runtime } from '#src/server/runtime.ts'

// The OAuth authorization endpoint (see oauth/oauth.ts), behind the web session: the gate sends a
// visitor without one to the login first. The query is read as is (the router would parse its
// values as JSON), and the page is plain HTML (see oauth/consent.ts).
export const Route = createFileRoute('/authorize')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const query = new URL(request.url).searchParams
        const asked = authorizeRequest((name) => query.get(name))
        const checked = await runtime.runPromise(
          OAuth.use((oauth) => oauth.check(asked, `${publicOrigin(request)}/mcp`))
        )
        return typeof checked === 'string' ? refusedPage(checked) : consentPage(asked, checked)
      },
    },
  },
})
