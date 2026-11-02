import { Effect, Fiber, Layer } from 'effect'
import { definePlugin } from 'nitro'

import { Jobs } from '../app.ts'

import { runtime } from './runtime.ts'

type JobsFiber = ReturnType<typeof startJobs>

declare global {
  var garminJobs: Promise<JobsFiber> | undefined
}

// The ingest of data/, on the shared runtime (see runtime.ts)
const startJobs = () => runtime.runFork(Layer.launch(Jobs))

// Never rejects: a failing stop is logged, so the next start and the shutdown still run
const stop = (fiber: JobsFiber | undefined) =>
  fiber === undefined
    ? Promise.resolve()
    : Effect.runPromise(Fiber.interrupt(fiber)).catch((error: unknown) => console.error(error))

// Starts the jobs at server boot, which builds the services (the migrations included). `vite dev`
// re-evaluates this plugin in-process after server edits: each start waits for the previous jobs to
// stop. On close, stops them and releases the services (SQLite), so the process exits.
export default definePlugin((nitroApp) => {
  const jobs = Promise.resolve(globalThis.garminJobs).then(stop).then(startJobs)
  globalThis.garminJobs = jobs
  nitroApp.hooks.hook('close', () => jobs.then(stop).then(() => runtime.dispose()))
})
