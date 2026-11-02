import { createFileRoute } from '@tanstack/react-router'

import { handleRpc } from '#src/api/server.ts'

// The API as RPC (see api/): the web pages' typed client, and scripts with a bearer token
export const Route = createFileRoute('/rpc/$')({
  server: { handlers: { ANY: ({ request }) => handleRpc(request) } },
})
