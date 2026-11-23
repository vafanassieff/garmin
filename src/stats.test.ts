import { expect, layer } from '@effect/vitest'
import { Effect, Layer } from 'effect'
import { describe, it } from 'vitest'

import { apiSummary, dailyFile, fitRun, put, testLayer } from '../test/fixtures.ts'

import { addDays, parisToday } from './days.ts'
import { Ingest, Storage } from './ingest.ts'
import {
  minutesFromNoon,
  minutesOf,
  sleepAverages,
  Stats,
  withClock,
  type SleepNight,
} from './stats.ts'

const TestLayer = testLayer(Stats.layer.pipe(Layer.provideMerge(Storage)))

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

      const runs = yield* stats.runs(26)
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
      // The whole history: from the first night (at least 30)
      expect(yield* stats.sleep('all')).toMatchObject({ span: 'all', days: 30 })
      expect((yield* stats.runs('all')).weeks).toHaveLength(26)
      const everything = yield* stats.activities(null)
      expect(everything.activities.map((activity) => activity.id)).toEqual([42])
      expect(everything.activities[0]).toMatchObject({ on_foot: true, speed_kmh: 10.9 })
      expect(everything.sports).toEqual([{ sport: 'running', count: 1 }])
      expect((yield* stats.activities('cycling')).activities).toEqual([])
    })
  )
})

layer(TestLayer, { excludeTestServices: true })('Stats, the morning', (it) => {
  it.effect("reads today's plan, energy and journal", () =>
    Effect.gen(function* () {
      const today = yield* parisToday
      const before = addDays(today, -3)
      // A past run to price today's: 300 kcal over 1190 s
      yield* put('fit/2026/43.fit', fitRun({ start: new Date(`${before}T06:12:40Z`) }))
      yield* put(
        'connect/activities/2026/43.json',
        apiSummary(43, { startTimeLocal: `${before} 07:12:40`, startTimeGMT: `${before} 06:12:40` })
      )
      // A week of nights (52 ms, 58 bpm) and today's: a normal to judge it by. The days without an
      // activity burnt 2160 kcal; the run's day, 3000, is no rest day, nor today, partial (800)
      for (const day of [
        today,
        ...Array.from({ length: 7 }, (_, index) => addDays(today, -1 - index)),
      ]) {
        const file = dailyFile(day)
        yield* put(
          `connect/daily/${day.slice(0, 4)}/${day}.json`,
          day === before || day === today
            ? { ...file, stats: { ...file.stats, totalKilocalories: day === today ? 800 : 3000 } }
            : file
        )
      }
      yield* put(`connect/calendar/${today.slice(0, 7)}.json`, {
        calendarItems: [
          { id: 1, itemType: 'workout', title: 'Footing', date: today, workoutId: 9 },
        ],
      })
      yield* put('connect/workouts/9.json', {
        workoutId: 9,
        workoutName: 'Footing',
        sportType: { sportTypeKey: 'running' },
        estimatedDurationInSecs: 1800,
        workoutSegments: [],
      })
      yield* put(`connect/body/${today.slice(0, 7)}.json`, {
        startDate: `${today.slice(0, 7)}-01`,
        endDate: today,
        dateWeightList: [
          {
            calendarDate: today,
            timestampGMT: Date.parse(`${today}T06:00:00Z`),
            weight: 70_000,
            sourceType: 'INDEX_SCALE',
          },
        ],
      })
      const note = { time: `${today}T08:00:00.000Z`, day: today, text: 'Quadri raide' }
      yield* put(`journal/${today.slice(0, 4)}/${today}T08-00-00.000Z.json`, note)
      // The 14 days shown, and one older
      const last = addDays(today, -13)
      const lastNote = { time: `${last}T08:00:00.000Z`, day: last, text: 'Ampoule' }
      yield* put(`journal/${last.slice(0, 4)}/${last}T08-00-00.000Z.json`, lastNote)
      const old = addDays(today, -14)
      yield* put(`journal/${old.slice(0, 4)}/${old}T08-00-00.000Z.json`, {
        ...note,
        time: `${old}T08:00:00.000Z`,
        day: old,
      })
      yield* Ingest.use((ingest) => ingest.run())

      const { morning } = yield* Stats.use((stats) => stats.dashboard)
      // Today's night on its normal, Garmin's 6 hours of recovery left
      expect(morning.verdict).toMatchObject({ kind: 'judged', light: 'green', recovery_h: 6 })
      // 1800 s at 300 kcal per 1190 s
      expect(morning.planned).toEqual([
        { id: 1, name: 'Footing', steps: null, minutes: 30, kcal: expect.closeTo(453.78, 2) },
      ])
      // 454 less 30 minutes of the resting 2160 a day
      expect(morning.burn).toEqual({ kind: 'known', rest: 2160, sessions: 409, total: 2569 })
      expect(morning.protein_g).toBe(126)
      expect(morning.weighed).toBe(true)
      expect(morning.notes).toEqual([note, lastNote])
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
