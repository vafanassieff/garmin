import { utimesSync } from 'node:fs'
import { join } from 'node:path'

import * as NodeServices from '@effect/platform-node/NodeServices'
import { expect, layer } from '@effect/vitest'
import { Effect, Layer } from 'effect'

import {
  apiSummary,
  dailyFile,
  dataDir,
  fitRun,
  put,
  rows,
  sql,
  testConfig,
} from '../test/fixtures.ts'

import { Database } from './db.ts'
import { Ingest } from './ingest.ts'
import { Tools } from './tools.ts'

const TestLayer = Layer.mergeAll(Ingest.layer, Tools.layer).pipe(
  Layer.provideMerge(Database.layer),
  Layer.provideMerge(NodeServices.layer),
  Layer.provide(testConfig)
)

const run = (options?: { readonly rebuild?: boolean }) =>
  Ingest.use((ingest) => ingest.run(options))

layer(TestLayer, { excludeTestServices: true })('Ingest', (it) => {
  it.effect('builds an activity from its FIT file and its summary, then only reads changes', () =>
    Effect.gen(function* () {
      yield* put('fit/2026/101.fit', fitRun())
      yield* put('connect/activities/2026/101.json', apiSummary(101))
      // A summary without FIT file (a manual activity), and an export's summary the API's beats
      yield* put(
        'connect/activities/2026/102.json',
        apiSummary(102, {
          startTimeGMT: '2026-10-30 07:00:00',
          startTimeLocal: '2026-10-30 08:00:00',
        })
      )
      yield* put('connect/activities/2026/101.export.json', {
        activityId: 101,
        name: 'old',
        activityType: 'running',
        startTimeGmt: 0,
        startTimeLocal: 0,
      })
      yield* put('connect/daily/2026/2026-10-31.json', dailyFile('2026-10-31'))
      yield* put('fit/2026/.103.fit.partial', 'half a file')

      const first = yield* run()
      expect(first).toMatchObject({ files: 5, activities: 2, days: 1, errors: [] })
      expect(
        yield* rows(sql`SELECT id, name, sport, day, start_local, moving_s, distance_m, training_load,
          avg_cadence, hr_z4_s, gear, fit_file FROM activities ORDER BY id`)
      ).toEqual([
        {
          id: 101,
          name: 'Morning Run - Easy 20',
          sport: 'running',
          day: '2026-10-31',
          start_local: '2026-10-31T07:12:40',
          // Connect's moving time, the FIT file's distance
          moving_s: 1190,
          distance_m: 3600,
          training_load: 81.2,
          avg_cadence: 161,
          hr_z4_s: 500,
          gear: 'Road Shoes',
          fit_file: 'fit/2026/101.fit',
        },
        expect.objectContaining({ id: 102, day: '2026-10-30', fit_file: null, distance_m: 3600 }),
      ])
      expect(yield* rows(sql`SELECT count(*) AS n FROM samples WHERE activity_id = 101`)).toEqual([
        { n: 1201 },
      ])
      expect(yield* rows(sql`SELECT count(*) AS n FROM laps`)).toEqual([{ n: 2 }])
      expect(
        yield* rows(sql`SELECT pace_min_km, z4_min FROM activity_summary WHERE id = 101`)
      ).toEqual([{ pace_min_km: '5:33', z4_min: 8.3 }])

      expect(yield* run()).toMatchObject({ files: 0, activities: 0 })

      // Renamed in Garmin Connect: the summary changes, the activity is rebuilt, samples kept
      yield* put('connect/activities/2026/101.json', apiSummary(101, { activityName: 'Renamed' }))
      const root = yield* dataDir
      utimesSync(
        join(root, 'connect/activities/2026/101.json'),
        new Date(),
        new Date(Date.now() + 5000)
      )
      expect(yield* run()).toMatchObject({ files: 1, activities: 1 })
      expect(yield* rows(sql`SELECT name FROM activities WHERE id = 101`)).toEqual([
        { name: 'Renamed' },
      ])
      expect(yield* rows(sql`SELECT count(*) AS n FROM samples`)).toEqual([{ n: 1201 }])

      const tools = yield* Tools
      const activity = yield* tools.getActivity({ id: 101 })
      expect(activity).toMatchObject({ name: 'Renamed', decoupling_pct: expect.any(Number) })
      const readiness = yield* tools.dailyReadiness({ day: '2026-10-31', days: 1 })
      expect(readiness).toMatchObject({
        days: [{ day: '2026-10-31', readiness: 88, hrv: 52, sleep_h: 7.33 }],
      })

      expect(yield* tools.syncStatus).toMatchObject({
        last_success_at: null,
        last_runs: [],
        latest_activity: '2026-10-31T07:12:40',
        latest_sleep: '2026-10-31',
      })

      const rebuilt = yield* run({ rebuild: true })
      expect(rebuilt).toMatchObject({ files: 5, activities: 2, days: 1 })
    })
  )

  it.effect('records a broken file, and keeps going', () =>
    Effect.gen(function* () {
      yield* put('fit/2025/201.fit', 'not a fit file')
      yield* put('connect/daily/2025/2025-01-01.json', '{')
      const summary = yield* run()
      expect(summary.errors).toEqual([
        'connect/daily/2025/2025-01-01.json: not a daily file',
        'fit/2025/201.fit: not a FIT file',
      ])
      expect(
        yield* rows(sql`SELECT path, error FROM raw_files WHERE error IS NOT NULL ORDER BY path`)
      ).toHaveLength(2)
    })
  )
})
