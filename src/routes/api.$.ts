import { createFileRoute } from '@tanstack/react-router'

import { handleApi } from '#src/api/server.ts'

// The public API as OpenAPI (see api/garmin.ts), its document at /api/openapi.json
export const Route = createFileRoute('/api/$')({
  server: { handlers: { ANY: ({ request }) => handleApi(request) } },
})
