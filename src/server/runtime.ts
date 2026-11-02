import { ManagedRuntime, type Layer } from 'effect'

import { Services } from '../app.ts'

export const layer = Services

declare global {
  var garminRuntime:
    | ManagedRuntime.ManagedRuntime<Layer.Success<typeof layer>, Layer.Error<typeof layer>>
    | undefined
}

// Runs the jobs' Effects (see nitro.ts), the API's procedures (see api/) and the password check
// (see start.ts): the whole process shares one SQLite connection, the only writer. On globalThis,
// so `vite dev` re-evaluations reuse it, and for the Nitro plugin (bundled apart from the routes)
// to close it on shutdown.
globalThis.garminRuntime ??= ManagedRuntime.make(layer)
export const runtime = globalThis.garminRuntime
