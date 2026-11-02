import { createFileRoute } from '@tanstack/react-router'

import { endpoints } from '#src/server/runtime.ts'

// Served by the Effect router (see http.ts), like the MCP
export const Route = createFileRoute('/healthz')({
  server: { handlers: { ANY: ({ request }) => endpoints.handler(request) } },
})
