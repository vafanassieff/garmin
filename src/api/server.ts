import { runtime } from '../server/runtime.ts'

import { makeHandlers, makeRun } from './handlers.ts'

// The API over the app's runtime (see handlers.ts), for routes/ and the web pages' client
export const run = makeRun(runtime)

export const { handleRpc, handleApi, handleMcp } = makeHandlers(run)
