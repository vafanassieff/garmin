import { Layer, ManagedRuntime } from 'effect'
import { HttpRouter } from 'effect/http'

import { Endpoints, Services } from '../app.ts'

export const layer = Services

const makeEndpoints = (memoMap: Layer.MemoMap) =>
  HttpRouter.toWebHandler(Endpoints.pipe(Layer.provide(layer)), { memoMap })

declare global {
  var garminRuntime:
    | ManagedRuntime.ManagedRuntime<Layer.Success<typeof layer>, Layer.Error<typeof layer>>
    | undefined
  var garminEndpoints: ReturnType<typeof makeEndpoints> | undefined
}

// Runs the jobs' Effects (see nitro.ts) and the password check (see start.ts). The Effect HTTP
// routes are built on its memo map, so the whole process shares one SQLite connection, the only
// writer. On globalThis, so `vite dev` re-evaluations reuse them, and for the Nitro plugin (bundled
// apart from the routes) to close them on shutdown.
globalThis.garminRuntime ??= ManagedRuntime.make(layer)
export const runtime = globalThis.garminRuntime

// The MCP and the health check as a fetch handler (see routes/)
globalThis.garminEndpoints ??= makeEndpoints(runtime.memoMap)
export const endpoints = globalThis.garminEndpoints
