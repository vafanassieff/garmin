import * as NodeServices from '@effect/platform-node/NodeServices'
import { Layer } from 'effect'
import { FetchHttpClient } from 'effect/http'

import { Auth } from './auth.ts'
import { Database } from './db.ts'
import { GarminApi } from './garmin/api.ts'
import { GarminLogin } from './garmin/login.ts'
import { GarminSession } from './garmin/session.ts'
import { GarminSync } from './garmin/sync.ts'
import { GarminWorkouts } from './garmin/workouts.ts'
import { Ingest } from './ingest.ts'
import { OAuth } from './oauth/oauth.ts'
import { Reader } from './reader.ts'
import { Stats } from './stats.ts'
import { Tools } from './tools.ts'

// The Garmin account: its session (a file of its own), the API, the sync into data/ and SQLite,
// the login (web and CLI), the workouts written to its calendar (the MCP's)
export const Garmin = Layer.merge(GarminLogin.layer, GarminWorkouts.layer).pipe(
  Layer.provideMerge(GarminSync.layer),
  Layer.provideMerge(GarminApi.layer),
  Layer.provideMerge(GarminSession.layer),
  Layer.provideMerge(FetchHttpClient.layer)
)

// SQLite (migrated), the ingest of data/, Garmin, the MCP's and the web pages' queries, the
// password and the MCP's OAuth server
export const Services = Layer.mergeAll(Reader.layer, Tools.layer, Stats.layer, OAuth.layer).pipe(
  Layer.provideMerge(Garmin),
  Layer.provideMerge(Ingest.layer),
  Layer.provideMerge(Database.layer),
  Layer.provideMerge(Layer.merge(NodeServices.layer, Auth.layer))
)

// The background jobs: the Garmin sync every 3 hours (it ingests what it wrote), and the ingest of
// data/ every 5 minutes for what lands there otherwise (an export's backfill)
export const Jobs = Layer.mergeAll(GarminSync.scheduler, Ingest.scheduler)
