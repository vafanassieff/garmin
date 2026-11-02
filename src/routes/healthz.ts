import { createFileRoute } from '@tanstack/react-router'

// The container's health check: the server answers
export const Route = createFileRoute('/healthz')({
  server: {
    handlers: {
      GET: () => new Response('ok\n', { headers: { 'content-type': 'text/plain; charset=utf-8' } }),
    },
  },
})
