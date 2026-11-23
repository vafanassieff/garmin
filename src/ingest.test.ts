import { utimesSync } from 'node:fs'
import { join } from 'node:path'

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
  testLayer,
} from '../test/fixtures.ts'

import { Ingest, Storage } from './ingest.ts'
import { Tools } from './tools.ts'

const TestLayer = testLayer(Tools.layer.pipe(Layer.provideMerge(Storage)))

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

  it.effect('keeps Garmin and Withings weigh-ins apart, Withings winning an instant', () =>
    Effect.gen(function* () {
      const garminMonth = (weights: ReadonlyArray<readonly [string, number]>) => ({
        startDate: '2024-03-01',
        endDate: '2024-03-31',
        dateWeightList: weights.map(([at, grams]) => ({
          calendarDate: at.slice(0, 10),
          timestampGMT: Date.parse(at),
          weight: grams,
          sourceType: 'INDEX_SCALE',
        })),
      })
      const withingsMonth = (weights: ReadonlyArray<readonly [string, number]>) => ({
        month: '2024-03',
        timezone: 'Europe/Paris',
        measuregrps: weights.map(([at, kg]) => ({
          date: Date.parse(at) / 1000,
          category: 1,
          attrib: 0,
          measures: [{ type: 1, value: kg * 100, unit: -2 }],
        })),
      })
      const weighIns = rows(
        sql`SELECT time, weight_kg, source FROM body WHERE day LIKE '2024-03-%' ORDER BY time`
      )
      // The same weigh-in at 07:00 in both, copied to Garmin by another app
      yield* put('withings/2024-03.json', withingsMonth([['2024-03-02T07:00:00Z', 70.1]]))
      yield* put(
        'connect/body/2024-03.json',
        garminMonth([
          ['2024-03-02T07:00:00Z', 70_000],
          ['2024-03-03T07:00:00Z', 69_800],
        ])
      )
      yield* run()
      const both = [
        { time: '2024-03-02T07:00:00.000Z', weight_kg: 70.1, source: 'WITHINGS' },
        { time: '2024-03-03T07:00:00.000Z', weight_kg: 69.8, source: 'INDEX_SCALE' },
      ]
      expect(yield* weighIns).toEqual(both)

      // Garmin's month again: the Withings rows stay
      const root = yield* dataDir
      utimesSync(join(root, 'connect/body/2024-03.json'), new Date(), new Date(Date.now() + 5000))
      yield* run()
      expect(yield* weighIns).toEqual(both)

      // Withings' month again, a weigh-in more: it wins its instant whatever the order
      yield* put(
        'withings/2024-03.json',
        withingsMonth([
          ['2024-03-02T07:00:00Z', 70.1],
          ['2024-03-03T07:00:00Z', 69.9],
        ])
      )
      utimesSync(join(root, 'withings/2024-03.json'), new Date(), new Date(Date.now() + 10_000))
      yield* run()
      expect(yield* weighIns).toEqual([
        both[0],
        { time: '2024-03-03T07:00:00.000Z', weight_kg: 69.9, source: 'WITHINGS' },
      ])

      // An export landing after them, with Garmin's copy of the same weigh-in: Withings' stays
      const withingsRows = [
        both[0],
        { time: '2024-03-03T07:00:00.000Z', weight_kg: 69.9, source: 'WITHINGS' },
      ]
      yield* put('export/zip/biometrics.json', {
        weights: [
          {
            timestampGMT: Date.parse('2024-03-02T07:00:00Z'),
            calendarDate: '2024-03-02',
            weight: 70_000,
            sourceType: 'INDEX_SCALE',
          },
        ],
      })
      yield* run()
      expect(yield* weighIns).toEqual(withingsRows)

      // Rebuilt from the files: the same rows
      yield* run({ rebuild: true })
      expect(yield* weighIns).toEqual(withingsRows)
    })
  )

  it.effect('files the journal: a note per file, kept across a rebuild', () =>
    Effect.gen(function* () {
      const note = { time: '2024-04-02T18:30:00.000Z', day: '2024-04-02', text: 'Quadri raide' }
      yield* put('journal/2024/2024-04-02T18-30-00.000Z.json', note)
      yield* put('journal/2024/broken.json', { day: '2024-04-02', text: '' })
      const summary = yield* run()
      expect(summary.errors).toEqual(['journal/2024/broken.json: not a journal note'])
      const notes = rows(sql`SELECT time, day, text FROM journal`)
      expect(yield* notes).toEqual([note])
      yield* run({ rebuild: true })
      expect(yield* notes).toEqual([note])
    })
  )
})
