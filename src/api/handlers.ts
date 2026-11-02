import { createMcpHandler, McpServer } from '@modelcontextprotocol/server'
import { SmartCoercionHandlerPlugin } from '@orpc/json-schema'
import { McpRegistrar } from '@orpc/mcp'
import { OpenAPIGenerator } from '@orpc/openapi'
import { OpenAPIHandler } from '@orpc/openapi/fetch'
import { onError, ORPCError } from '@orpc/server'
import { RPCHandler } from '@orpc/server/fetch'
import { Cause, Effect, Exit, Option } from 'effect'
import type { ManagedRuntime } from 'effect'

import { publicOrigin } from '../auth.ts'

import type { ApiContext, Run, Services } from './base.ts'
import { garmin } from './garmin.ts'
import { router } from './router.ts'

// The API's three faces, behind the gate (see auth.ts): the MCP at /mcp (the public procedures as
// tools), OpenAPI at /api (and its document at /api/openapi.json), RPC at /rpc (every procedure,
// the web pages' too), over a runtime of the app's services (server.ts binds the app's).

const message = (error: unknown) =>
  typeof error === 'object' &&
  error !== null &&
  'message' in error &&
  typeof error.message === 'string' &&
  error.message !== '' &&
  !('_tag' in error && error._tag === 'DatabaseError')
    ? error.message
    : undefined

// A failure the caller can act on (a refused input, a Garmin error) as BAD_REQUEST with its
// message; anything else logged and answered without detail
export const makeRun =
  (runtime: ManagedRuntime.ManagedRuntime<Services, unknown>): Run =>
  async (effect) => {
    const exit = await runtime.runPromiseExit(effect)
    if (Exit.isSuccess(exit)) return exit.value
    const failure = Option.getOrUndefined(Cause.findErrorOption(exit.cause))
    const said = message(failure)
    if (said !== undefined) throw new ORPCError('BAD_REQUEST', { message: said })
    await runtime.runPromise(Effect.logError('API call failed', exit.cause))
    throw new ORPCError('INTERNAL_SERVER_ERROR', { message: 'The server could not answer.' })
  }

export const makeHandlers = (run: Run) => {
  const contextOf = (request: Request): ApiContext => ({ run, origin: publicOrigin(request) })

  // An error the procedures did not shape (a bug): logged, sent without detail by oRPC
  const logUnexpected = (error: unknown) => {
    if (!(error instanceof ORPCError)) console.error('API', error)
  }

  const notFound = () => new Response('Not found\n', { status: 404 })

  const rpc = new RPCHandler(router, { interceptors: [onError(logUnexpected)] })

  const handleRpc = async (request: Request) =>
    (await rpc.handle(request, { prefix: '/rpc', context: contextOf(request) })).response ??
    notFound()

  // Query and path parameters arrive as text: coerced to the schemas' types
  const openApi = new OpenAPIHandler(garmin, {
    plugins: [new SmartCoercionHandlerPlugin()],
    interceptors: [onError(logUnexpected)],
  })

  let document: ReturnType<OpenAPIGenerator['generate']> | undefined
  const openApiDocument = () =>
    (document ??= new OpenAPIGenerator().generate(garmin, {
      base: {
        info: {
          title: 'Garmin',
          version: '1.0.0',
          description:
            "The user's Garmin data and the workouts on their watch. Authorization: Bearer <the app's password or an OAuth access token>.",
        },
        components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } } },
        security: [{ bearer: [] }],
      },
    }))

  const handleApi = async (request: Request) => {
    const url = new URL(request.url)
    if (url.pathname === '/api/openapi.json' && request.method === 'GET') {
      return Response.json({
        ...(await openApiDocument()),
        servers: [{ url: `${publicOrigin(request)}/api` }],
      })
    }
    return (
      (await openApi.handle(request, { prefix: '/api', context: contextOf(request) })).response ??
      notFound()
    )
  }

  const registrar = new McpRegistrar(garmin, { clientInterceptors: [onError(logUnexpected)] })

  // Stateless: a server for each request, the 2025 protocol revisions served too
  const mcp = createMcpHandler(async ({ requestInfo }) => {
    const server = new McpServer({ name: 'garmin', version: '1.0.0' })
    await registrar.register(server, {
      context: { run, origin: requestInfo === undefined ? '' : publicOrigin(requestInfo) },
    })
    return server
  })

  const handleMcp = (request: Request) => mcp.fetch(request)

  return { handleRpc, handleApi, handleMcp }
}
