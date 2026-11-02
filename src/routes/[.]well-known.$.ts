import { createFileRoute } from '@tanstack/react-router'

import { publicOrigin } from '#src/auth.ts'
import { json, resourceMetadata, serverMetadata } from '#src/oauth/http.ts'

// The OAuth metadata MCP clients look for (see oauth/oauth.ts): the MCP's (RFC 9728, at the root
// and suffixed with its path), then its authorization server's (RFC 8414)
export const Route = createFileRoute('/.well-known/$')({
  server: {
    handlers: {
      GET: ({ request, params }) => {
        const origin = publicOrigin(request)
        switch (params._splat) {
          case 'oauth-protected-resource':
          case 'oauth-protected-resource/mcp': {
            return json(resourceMetadata(origin))
          }
          case 'oauth-authorization-server': {
            return json(serverMetadata(origin))
          }
          default: {
            return new Response('Not found\n', { status: 404 })
          }
        }
      },
    },
  },
})
