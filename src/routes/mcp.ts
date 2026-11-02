import { createFileRoute } from '@tanstack/react-router'

import { endpoints } from '#src/server/runtime.ts'

// The MCP (see mcp.ts), streamable HTTP: POST, GET and DELETE
export const Route = createFileRoute('/mcp')({
  server: { handlers: { ANY: ({ request }) => endpoints.handler(request) } },
})
