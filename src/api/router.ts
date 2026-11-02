import { garmin } from './garmin.ts'
import { web } from './web.ts'

// Every procedure: the public API (garmin.ts) and the web pages' calls (web.ts, under web)
export const router = { ...garmin, web }

export type Router = typeof router
