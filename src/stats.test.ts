import * as NodeServices from '@effect/platform-node/NodeServices'
import { expect, layer } from '@effect/vitest'
import { Effect, Layer } from 'effect'
import { describe, it } from 'vitest'

import { apiSummary, dailyFile, fitRun, put, testConfig } from '../test/fixtures.ts'

import { Database } from './db.ts'
import { Ingest } from './ingest.ts'
import {
  minutesFromNoon,
  minutesOf,
  sleepAverages,
  Stats,
  withClock,
  type SleepNight,
} from './stats.ts'
import { parisToday } from './tools.ts'

const TestLayer = Layer.mergeAll(Ingest.layer, Stats.layer).pipe(
  Layer.provideMerge(Database.layer),
  Layer.provideMerge(NodeServices.layer),
  Layer.provide(testConfig)
)

const addDays = (day: string, days: number) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10)

// The real clock: the pages' periods end today
layer(TestLayer, { excludeTestServices: true })('Stats', (it) => {
  it.effect('reads the runs, one activity and the sleep of the database', () =>
    Effect.gen(function* () {
      const today = yield* parisToday
      const yesterday = addDays(today, -1)
      yield* put('fit/2026/42.fit', fitRun({ start: new Date(`${today}T06:12:40Z`) }))
      yield* put(
        'connect/activities/2026/42.json',
        apiSummary(42, {
          startTimeLocal: `${today} 07:12:40`,
          startTimeGMT: `${today} 06:12:40`,
        })
      )
      yield* put(`connect/daily/2026/${today}.json`, dailyFile(today))
      yield* put(`connect/daily/2026/${yesterday}.json`, dailyFile(yesterday))
      yield* Ingest.use((ingest) => ingest.run())
      const stats = yield* Stats

      const runs = yield* stats.runs
      expect(runs.last28).toMatchObject({ runs: 1, distance_km: 3.6 })
      // 1190 s over 3.6 km
      expect(runs.last28.pace_s).toBe(331)
      expect(runs.previous28).toMatchObject({ runs: 0, pace_s: null, avg_hr: null })
      expect(runs.weeks).toHaveLength(26)
      expect(runs.weeks.at(-1)).toMatchObject({ runs: 1, distance_km: 3.6 })
      expect(runs.runs.map((run) => run.id)).toEqual([42])
      expect(runs.longest?.id).toBe(42)
      expect(runs.predictions).toMatchObject({ day: today, race_5k_s: 1395 })
      expect(runs.vo2max).toEqual({ day: today, value: 51.3 })

      const activity = yield* stats.activity(42)
      expect(activity).toMatchObject({ id: 42, on_foot: true, distance_km: 3.6, moving_s: 1190 })
      expect(activity?.minutes).toHaveLength(21)
      expect(activity?.minutes[0]).toMatchObject({ minute: 0, pace_s: 333, speed_kmh: 10.8 })
      expect(activity?.splits.map((split) => split.km)).toEqual([1, 2, 3, 4])
      expect(activity?.laps).toHaveLength(2)
      expect(yield* stats.activity(7)).toBeNull()

      const sleep = yield* stats.sleep(30)
      expect(sleep.days).toBe(30)
      expect(sleep.nights).toHaveLength(30)
      expect(sleep.nights.at(-1)).toMatchObject({ day: today, sleep_s: 26_400, hrv: 52 })
      expect(sleep.nights[0]?.sleep_s).toBeNull()
      expect(sleep.last).toMatchObject({ day: today, hrv_baseline_low: 46 })
      expect(sleep.averages).toMatchObject({ nights: 2, sleep_s: 26_400, sleep_score: 78 })
      expect(sleep.previous.nights).toBe(0)
      // Asked for more than a year: a year
      expect((yield* stats.sleep(10_000)).days).toBe(366)
    })
  )
})

const night = (overrides: Partial<SleepNight>): SleepNight => ({
  day: '2026-10-31',
  sleep_start: null,
  sleep_end: null,
  bed_min: null,
  wake_min: null,
  sleep_s: null,
  deep_s: null,
  light_s: null,
  rem_s: null,
  awake_s: null,
  nap_s: null,
  sleep_score: null,
  hrv: null,
  hrv_weekly: null,
  hrv_status: null,
  hrv_baseline_low: null,
  hrv_baseline_high: null,
  resting_hr: null,
  respiration_avg: null,
  spo2_avg: null,
  body_battery_charged: null,
  body_battery_wake: null,
  ...overrides,
})

describe('stats helpers', () => {
  it('puts bedtimes and wake times on one axis, in Paris time', () => {
    // 22:30 in Paris in winter (UTC+1), 23:30 in summer (UTC+2)
    expect(minutesFromNoon('2026-12-01T21:30:00.000Z')).toBe(630)
    expect(minutesFromNoon('2026-07-01T21:30:00.000Z')).toBe(690)
    // After midnight
    expect(minutesFromNoon('2026-12-02T05:15:00.000Z')).toBe(1095)
    expect(minutesFromNoon(null)).toBeNull()
    // Asleep at 03:00, awake at 13:15: the wake time goes past the axis's end, after the bedtime
    expect(
      withClock(
        night({ sleep_start: '2026-12-02T02:00:00.000Z', sleep_end: '2026-12-02T12:15:00.000Z' })
      )
    ).toMatchObject({ bed_min: 900, wake_min: 1515 })
    expect(minutesFromNoon('nope')).toBeNull()
  })

  it('averages the nights that have data', () => {
    const averages = sleepAverages([
      night({ sleep_s: 28_800, deep_s: 6000, light_s: 18_000, rem_s: 6000, bed_min: 600 }),
      night({ sleep_s: 25_200, deep_s: 4000, light_s: 16_000, rem_s: 4000, bed_min: 660 }),
      night({}),
    ])
    expect(averages).toMatchObject({
      nights: 2,
      sleep_s: 27_000,
      deep_pct: 19,
      rem_pct: 19,
      bed_min: 630,
      bed_spread_min: 30,
    })
    expect(sleepAverages([]).sleep_s).toBeNull()
  })

  it('averages the samples per minute, a pace only when moving', () => {
    const minutes = minutesOf([
      { t: 0, hr: 100, speed: 2, cadence: 160, alt: 10, distance: 0, power: null },
      { t: 30, hr: 110, speed: 4, cadence: 170, alt: 12, distance: 90, power: null },
      { t: 60, hr: 120, speed: 0.2, cadence: null, alt: 12, distance: 92, power: null },
    ])
    expect(minutes).toEqual([
      { minute: 0, hr: 105, pace_s: 333, speed_kmh: 10.8, alt: 11, cadence: 165 },
      { minute: 1, hr: 120, pace_s: null, speed_kmh: 0.7, alt: 12, cadence: null },
    ])
    // A pause: the minutes without samples are there, empty
    const paused = minutesOf([
      { t: 0, hr: 100, speed: 3, cadence: 160, alt: 10, distance: 0, power: null },
      { t: 190, hr: 110, speed: 3, cadence: 160, alt: 10, distance: 570, power: null },
    ])
    expect(paused.map((minute) => [minute.minute, minute.hr])).toEqual([
      [0, 100],
      [1, null],
      [2, null],
      [3, 110],
    ])
    expect(minutesOf([])).toEqual([])
  })
})
