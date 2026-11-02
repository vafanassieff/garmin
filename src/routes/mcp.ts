import { createFileRoute } from '@tanstack/react-router'

import { handleMcp } from '#src/api/server.ts'

// The MCP (streamable HTTP): the public API's procedures as tools (see api/garmin.ts)
export const Route = createFileRoute('/mcp')({
  server: { handlers: { ANY: ({ request }) => handleMcp(request) } },
})
