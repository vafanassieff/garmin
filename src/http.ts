import { Effect } from 'effect'
import { HttpRouter, HttpServerResponse } from 'effect/http'

// The health check, served by the Effect router beside the MCP (see routes/)
export const Routes = HttpRouter.use((router) =>
  Effect.gen(function* () {
    yield* router.add(
      'GET',
      '/healthz',
      HttpServerResponse.text('ok\n', { contentType: 'text/plain; charset=utf-8' })
    )
  })
)
