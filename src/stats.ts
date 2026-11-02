import { sql, type SQL } from 'drizzle-orm'
import { Context, Effect, Layer } from 'effect'

import { Database, type DatabaseError } from './db.ts'
import { decode, type Point } from './polyline.ts'
import { decoupling, kmSplits, parisToday, type SamplePoint, type Split } from './tools.ts'

// The web pages' numbers (routes/): plain JSON, computed in SQLite

export interface Totals {
  readonly activities: number
  readonly first_day: string | null
  readonly days: number
  readonly distance_km: number
}

export interface Period {
  readonly activities: number
  readonly distance_km: number
  readonly moving_h: number
  readonly training_load: number
}

export interface Night {
  readonly day: string
  readonly sleep_s: number | null
  readonly sleep_score: number | null
  readonly hrv: number | null
  readonly hrv_status: string | null
  readonly resting_hr: number | null
  readonly readiness: number | null
  readonly body_battery_wake: number | null
  readonly vo2max: number | null
}

export interface Week {
  readonly week: string
  readonly run_h: number
  readonly bike_h: number
  readonly other_h: number
  readonly moving_h: number
  readonly training_load: number
}

export interface RecentActivity {
  readonly id: number
  readonly day: string
  readonly sport: string
  readonly name: string | null
  readonly distance_km: number | null
  readonly moving_min: number | null
  // Seconds per km over the moving time (on foot only), as on the other pages
  readonly pace_s: number | null
  readonly avg_hr: number | null
  readonly training_load: number | null
}

export interface Dashboard {
  readonly today: string
  readonly totals: Totals
  readonly last7: Period
  readonly previous7: Period
  readonly night: Night | null
  readonly nights: ReadonlyArray<Night>
  readonly weeks: ReadonlyArray<Week>
  readonly recent: ReadonlyArray<RecentActivity>
}

// Running (routes/runs.tsx)

export interface RunRow {
  readonly id: number
  readonly day: string
  readonly start_local: string
  readonly name: string | null
  readonly sport: string
  readonly distance_km: number | null
  readonly moving_s: number | null
  // Seconds per km
  readonly pace_s: number | null
  readonly avg_hr: number | null
  readonly ascent_m: number | null
  readonly training_load: number | null
  readonly aerobic_te: number | null
}

export interface RunPeriod {
  readonly runs: number
  readonly distance_km: number
  readonly moving_h: number
  readonly ascent_m: number
  readonly pace_s: number | null
  readonly avg_hr: number | null
}

export interface RunWeek {
  readonly week: string
  readonly distance_km: number
  readonly runs: number
}

export interface Zones {
  readonly z1_s: number
  readonly z2_s: number
  readonly z3_s: number
  readonly z4_s: number
  readonly z5_s: number
}

export interface Predictions {
  readonly day: string
  readonly race_5k_s: number | null
  readonly race_10k_s: number | null
  readonly race_half_s: number | null
  readonly race_marathon_s: number | null
}

export interface RunsView {
  readonly today: string
  readonly year: RunPeriod
  readonly last28: RunPeriod
  readonly previous28: RunPeriod
  readonly longest: RunRow | null
  readonly vo2max: { readonly day: string; readonly value: number } | null
  readonly predictions: Predictions | null
  // 26 ISO weeks, oldest first, the empty ones included
  readonly weeks: ReadonlyArray<RunWeek>
  // The last 28 days' time per HR zone
  readonly zones: Zones
  // The last 26 weeks' runs, newest first
  readonly runs: ReadonlyArray<RunRow>
}

// One activity (routes/activities.$id.tsx)

export interface Minute {
  readonly minute: number
  readonly hr: number | null
  // Seconds per km, null when standing (under 0.5 m/s)
  readonly pace_s: number | null
  readonly speed_kmh: number | null
  readonly alt: number | null
  readonly cadence: number | null
}

export interface Lap {
  readonly lap: number
  readonly distance_m: number | null
  readonly moving_s: number | null
  readonly pace_s: number | null
  readonly speed_kmh: number | null
  readonly avg_hr: number | null
  readonly max_hr: number | null
  readonly cadence: number | null
  readonly ascent_m: number | null
  readonly intensity: string | null
}

export interface ActivityView {
  readonly id: number
  readonly day: string
  readonly start_local: string
  readonly name: string | null
  readonly sport: string
  // Running, walking, hiking: a pace; else a speed
  readonly on_foot: boolean
  readonly distance_km: number | null
  readonly moving_s: number | null
  readonly elapsed_s: number | null
  readonly pace_s: number | null
  readonly speed_kmh: number | null
  readonly avg_hr: number | null
  readonly max_hr: number | null
  readonly ascent_m: number | null
  readonly descent_m: number | null
  readonly cadence: number | null
  readonly avg_power: number | null
  readonly calories: number | null
  readonly training_load: number | null
  readonly aerobic_te: number | null
  readonly anaerobic_te: number | null
  readonly te_label: string | null
  readonly vo2max: number | null
  readonly rpe: number | null
  readonly workout_name: string | null
  readonly gear: string | null
  readonly device: string | null
  readonly decoupling_pct: number | null
  readonly zones: Zones | null
  readonly route: ReadonlyArray<Point>
  readonly minutes: ReadonlyArray<Minute>
  readonly splits: ReadonlyArray<Split>
  readonly laps: ReadonlyArray<Lap>
}

// Sleep (routes/sleep.tsx)

export interface SleepNight {
  readonly day: string
  readonly sleep_start: string | null
  readonly sleep_end: string | null
  // Minutes from noon the day before, Paris time: 22:30 is 630, 06:15 is 1095
  readonly bed_min: number | null
  readonly wake_min: number | null
  readonly sleep_s: number | null
  readonly deep_s: number | null
  readonly light_s: number | null
  readonly rem_s: number | null
  readonly awake_s: number | null
  readonly nap_s: number | null
  readonly sleep_score: number | null
  readonly hrv: number | null
  readonly hrv_weekly: number | null
  readonly hrv_status: string | null
  readonly hrv_baseline_low: number | null
  readonly hrv_baseline_high: number | null
  readonly resting_hr: number | null
  readonly respiration_avg: number | null
  readonly spo2_avg: number | null
  readonly body_battery_charged: number | null
  readonly body_battery_wake: number | null
}

export interface SleepAverages {
  readonly nights: number
  readonly sleep_s: number | null
  readonly sleep_score: number | null
  readonly deep_pct: number | null
  readonly rem_pct: number | null
  readonly bed_min: number | null
  readonly wake_min: number | null
  // The bedtimes' standard deviation, in minutes: under 30, a regular schedule
  readonly bed_spread_min: number | null
  readonly hrv: number | null
  readonly resting_hr: number | null
}

export interface SleepView {
  readonly today: string
  readonly days: number
  readonly last: SleepNight | null
  // Every day of the period, oldest first (a night without data has nulls)
  readonly nights: ReadonlyArray<SleepNight>
  readonly averages: SleepAverages
  readonly previous: SleepAverages
}

const RUN = `(sport LIKE '%running%')`
const BIKE = `(sport LIKE '%cycling%' OR sport LIKE '%biking%')`
// Garmin gives no moving time to some sports (climbing): their elapsed time then
const TIME = `coalesce(CASE WHEN moving_s > 0 THEN moving_s END, elapsed_s, 0)`

// Running, walking (casual_walking, speed_walking too), hiking: a pace rather than a speed
const ON_FOOT = `(sport LIKE '%running%' OR sport LIKE '%walking%' OR sport = 'hiking')`
// Seconds per km over the moving time, as the pages' durations (Connect's avg_speed is over the
// timer's time, stops included): distance / duration = pace on every page
const PACE = `CASE WHEN distance_m > 0 AND moving_s > 0 THEN round(moving_s * 1000 / distance_m)
  WHEN avg_speed > 0 THEN round(1000 / avg_speed) END`
const SPEED = `CASE WHEN distance_m > 0 AND moving_s > 0 THEN round(distance_m / moving_s * 3.6, 1)
  ELSE round(avg_speed * 3.6, 1) END`

const addDays = (day: string, days: number) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10)

// The Monday of the ISO week of `day`
const mondayOf = (day: string) =>
  addDays(day, -((new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7))

const mean = (values: ReadonlyArray<number>) =>
  values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length
const present = <A>(values: ReadonlyArray<A | null>) =>
  values.filter((value): value is A => value !== null)
const rounded = (value: number | null, digits = 0) =>
  value === null ? null : Number(value.toFixed(digits))

const parisClock = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Paris',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})

// Minutes from noon (Paris time), so that a night's bedtime and wake time sort on one axis
export const minutesFromNoon = (iso: string | null) => {
  if (iso === null) return null
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return null
  const parts = parisClock.formatToParts(date)
  const hour = Number(parts.find((part) => part.type === 'hour')?.value)
  const minute = Number(parts.find((part) => part.type === 'minute')?.value)
  return (hour * 60 + minute - 720 + 1440) % 1440
}

export const sleepAverages = (nights: ReadonlyArray<SleepNight>): SleepAverages => {
  const slept = nights.filter((night) => night.sleep_s !== null)
  const staged = slept.filter(
    (night) => night.deep_s !== null && night.light_s !== null && night.rem_s !== null
  )
  const stagedTotal = staged.reduce(
    (sum, night) => sum + (night.deep_s ?? 0) + (night.light_s ?? 0) + (night.rem_s ?? 0),
    0
  )
  const share = (pick: (night: SleepNight) => number | null) =>
    stagedTotal > 0
      ? rounded((staged.reduce((sum, night) => sum + (pick(night) ?? 0), 0) / stagedTotal) * 100)
      : null
  const beds = present(slept.map((night) => night.bed_min))
  const bed = mean(beds)
  return {
    nights: slept.length,
    sleep_s: rounded(mean(present(slept.map((night) => night.sleep_s)))),
    sleep_score: rounded(mean(present(nights.map((night) => night.sleep_score)))),
    deep_pct: share((night) => night.deep_s),
    rem_pct: share((night) => night.rem_s),
    bed_min: rounded(bed),
    wake_min: rounded(mean(present(slept.map((night) => night.wake_min)))),
    bed_spread_min:
      bed === null || beds.length < 2
        ? null
        : rounded(Math.sqrt(mean(beds.map((value) => (value - bed) ** 2)) ?? 0)),
    hrv: rounded(mean(present(nights.map((night) => night.hrv)))),
    resting_hr: rounded(mean(present(nights.map((night) => night.resting_hr)))),
  }
}

// A night's bedtime and wake time as minutes from noon; woken after noon, past the axis's end
// (over 1440), not before the bedtime
export const withClock = (night: Omit<SleepNight, 'bed_min' | 'wake_min'>): SleepNight => {
  const bed = minutesFromNoon(night.sleep_start)
  const wake = minutesFromNoon(night.sleep_end)
  return {
    ...night,
    bed_min: bed,
    wake_min: wake !== null && bed !== null && wake < bed ? wake + 1440 : wake,
  }
}

// A minute's average of the samples: what a chart of the activity needs
export const minutesOf = (samples: ReadonlyArray<SamplePoint>): Array<Minute> => {
  const minutes = new Map<number, Array<SamplePoint>>()
  for (const sample of samples) {
    const minute = Math.floor(sample.t / 60)
    const part = minutes.get(minute)
    if (part === undefined) minutes.set(minute, [sample])
    else part.push(sample)
  }
  const keys = [...minutes.keys()]
  if (keys.length === 0) return []
  const first = Math.min(...keys)
  const last = Math.max(...keys)
  // Every minute from the first to the last: a pause is a gap in the line, not a shortcut
  return Array.from({ length: last - first + 1 }, (_, index) => {
    const minute = first + index
    const part = minutes.get(minute) ?? []
    const speed = mean(present(part.map((sample) => sample.speed)))
    return {
      minute,
      hr: rounded(mean(present(part.map((sample) => sample.hr)))),
      pace_s: speed !== null && speed > 0.5 ? Math.round(1000 / speed) : null,
      speed_kmh: speed === null ? null : rounded(speed * 3.6, 1),
      alt: rounded(mean(present(part.map((sample) => sample.alt))), 1),
      cadence: rounded(mean(present(part.map((sample) => sample.cadence)))),
    }
  })
}

const NO_ZONES: Zones = { z1_s: 0, z2_s: 0, z3_s: 0, z4_s: 0, z5_s: 0 }

export class Stats extends Context.Service<
  Stats,
  {
    readonly dashboard: Effect.Effect<Dashboard, DatabaseError>
    readonly runs: Effect.Effect<RunsView, DatabaseError>
    readonly activity: (id: number) => Effect.Effect<ActivityView | null, DatabaseError>
    readonly sleep: (days: number) => Effect.Effect<SleepView, DatabaseError>
  }
>()('garmin/Stats') {
  static readonly layer = Layer.effect(
    Stats,
    Effect.gen(function* () {
      const { use } = yield* Database
      const all = <A>(query: SQL) => use((db) => db.all<A>(query))

      const period = (from: string, to: string) =>
        Effect.map(
          all<Period>(sql`
            SELECT count(*) AS activities,
              coalesce(round(sum(distance_m) / 1000, 1), 0) AS distance_km,
              coalesce(round(sum(${sql.raw(TIME)}) / 3600, 1), 0) AS moving_h,
              coalesce(round(sum(training_load)), 0) AS training_load
            FROM activities WHERE day BETWEEN ${from} AND ${to}`),
          (rows) => rows[0] ?? { activities: 0, distance_km: 0, moving_h: 0, training_load: 0 }
        )

      const dashboard = Effect.gen(function* () {
        const today = yield* parisToday
        const [totals] = yield* all<Totals>(sql`
          SELECT count(*) AS activities, min(day) AS first_day,
            (SELECT count(*) FROM daily) AS days,
            coalesce(round(sum(distance_m) / 1000), 0) AS distance_km
          FROM activities`)
        const last7 = yield* period(addDays(today, -6), today)
        const previous7 = yield* period(addDays(today, -13), addDays(today, -7))
        // The last 28 nights, oldest first
        const nights = yield* all<Night>(sql`
          SELECT day, sleep_s, sleep_score, hrv, hrv_status, resting_hr, readiness,
            body_battery_wake, vo2max
          FROM daily WHERE day BETWEEN ${addDays(today, -27)} AND ${today} ORDER BY day`)
        const [night] = yield* all<Night>(sql`
          SELECT day, sleep_s, sleep_score, hrv, hrv_status, resting_hr, readiness,
            body_battery_wake,
            (SELECT vo2max FROM daily d WHERE d.vo2max IS NOT NULL ORDER BY d.day DESC LIMIT 1) AS vo2max
          FROM daily WHERE sleep_s IS NOT NULL OR hrv IS NOT NULL ORDER BY day DESC LIMIT 1`)
        // 12 ISO weeks, oldest first, the empty ones included
        const firstWeek = addDays(mondayOf(today), -7 * 11)
        const rows = yield* all<Week>(
          sql.raw(`
          SELECT date(day, '-6 days', 'weekday 1') AS week,
            round(sum(CASE WHEN ${RUN} THEN ${TIME} ELSE 0 END) / 3600, 1) AS run_h,
            round(sum(CASE WHEN ${BIKE} THEN ${TIME} ELSE 0 END) / 3600, 1) AS bike_h,
            round(sum(CASE WHEN NOT ${RUN} AND NOT ${BIKE} THEN ${TIME} ELSE 0 END) / 3600, 1) AS other_h,
            round(sum(${TIME}) / 3600, 1) AS moving_h,
            round(sum(coalesce(training_load, 0))) AS training_load
          FROM activities WHERE day >= '${firstWeek}'
          GROUP BY 1`)
        )
        const byWeek = new Map(rows.map((row) => [row.week, row]))
        const weeks = Array.from({ length: 12 }, (_, index) => {
          const week = addDays(firstWeek, index * 7)
          return (
            byWeek.get(week) ?? {
              week,
              run_h: 0,
              bike_h: 0,
              other_h: 0,
              moving_h: 0,
              training_load: 0,
            }
          )
        })
        const recent = yield* all<RecentActivity>(sql`
          SELECT id, day, sport, name, round(distance_m / 1000, 2) AS distance_km,
            round(${sql.raw(TIME)} / 60, 1) AS moving_min,
            CASE WHEN ${sql.raw(ON_FOOT)} THEN ${sql.raw(PACE)} END AS pace_s, avg_hr,
            round(training_load) AS training_load
          FROM activities ORDER BY start_local DESC LIMIT 12`)
        return {
          today,
          totals: totals ?? { activities: 0, first_day: null, days: 0, distance_km: 0 },
          last7,
          previous7,
          night: night ?? null,
          nights,
          weeks,
          recent,
        } satisfies Dashboard
      })

      const runPeriod = (from: string, to: string) =>
        Effect.map(
          all<RunPeriod>(sql`
            SELECT count(*) AS runs,
              coalesce(round(sum(distance_m) / 1000, 1), 0) AS distance_km,
              coalesce(round(sum(${sql.raw(TIME)}) / 3600, 1), 0) AS moving_h,
              coalesce(round(sum(ascent_m)), 0) AS ascent_m,
              round(sum(CASE WHEN distance_m > 0 AND moving_s > 0 THEN moving_s END) * 1000.0
                / sum(CASE WHEN distance_m > 0 AND moving_s > 0 THEN distance_m END)) AS pace_s,
              round(sum(CASE WHEN moving_s > 0 THEN avg_hr * moving_s END)
                / sum(CASE WHEN avg_hr IS NOT NULL AND moving_s > 0 THEN moving_s END)) AS avg_hr
            FROM activities WHERE ${sql.raw(RUN)} AND day BETWEEN ${from} AND ${to}`),
          (rows) =>
            rows[0] ?? {
              runs: 0,
              distance_km: 0,
              moving_h: 0,
              ascent_m: 0,
              pace_s: null,
              avg_hr: null,
            }
        )

      const RUN_ROW = `id, day, start_local, name, sport, round(distance_m / 1000, 2) AS distance_km,
        ${TIME} AS moving_s, ${PACE} AS pace_s,
        avg_hr, round(ascent_m) AS ascent_m, round(training_load) AS training_load, aerobic_te`

      const runs = Effect.gen(function* () {
        const today = yield* parisToday
        const firstWeek = addDays(mondayOf(today), -7 * 25)
        const year = yield* runPeriod(`${today.slice(0, 4)}-01-01`, today)
        const last28 = yield* runPeriod(addDays(today, -27), today)
        const previous28 = yield* runPeriod(addDays(today, -55), addDays(today, -28))
        const [longest] = yield* all<RunRow>(
          sql.raw(`SELECT ${RUN_ROW} FROM activities WHERE ${RUN} AND distance_m > 0
            ORDER BY distance_m DESC LIMIT 1`)
        )
        const [vo2max] = yield* all<{ day: string; value: number }>(sql`
          SELECT day, vo2max AS value FROM daily WHERE vo2max IS NOT NULL ORDER BY day DESC LIMIT 1`)
        const [predictions] = yield* all<Predictions>(sql`
          SELECT day, race_5k_s, race_10k_s, race_half_s, race_marathon_s FROM daily
          WHERE race_5k_s IS NOT NULL OR race_marathon_s IS NOT NULL ORDER BY day DESC LIMIT 1`)
        const weekRows = yield* all<RunWeek>(sql`
          SELECT date(day, '-6 days', 'weekday 1') AS week, count(*) AS runs,
            round(coalesce(sum(distance_m), 0) / 1000, 1) AS distance_km
          FROM activities WHERE ${sql.raw(RUN)} AND day >= ${firstWeek} GROUP BY 1`)
        const byWeek = new Map(weekRows.map((row) => [row.week, row]))
        const weeks = Array.from({ length: 26 }, (_, index) => {
          const week = addDays(firstWeek, index * 7)
          return byWeek.get(week) ?? { week, runs: 0, distance_km: 0 }
        })
        const [zones] = yield* all<Zones>(sql`
          SELECT coalesce(sum(hr_z1_s), 0) AS z1_s, coalesce(sum(hr_z2_s), 0) AS z2_s,
            coalesce(sum(hr_z3_s), 0) AS z3_s, coalesce(sum(hr_z4_s), 0) AS z4_s,
            coalesce(sum(hr_z5_s), 0) AS z5_s
          FROM activities WHERE ${sql.raw(RUN)} AND day >= ${addDays(today, -27)}`)
        const list = yield* all<RunRow>(sql`
          SELECT ${sql.raw(RUN_ROW)} FROM activities
          WHERE ${sql.raw(RUN)} AND day >= ${firstWeek} ORDER BY start_local DESC`)
        return {
          today,
          year,
          last28,
          previous28,
          longest: longest ?? null,
          vo2max: vo2max ?? null,
          predictions: predictions ?? null,
          weeks,
          zones: zones ?? NO_ZONES,
          runs: list,
        } satisfies RunsView
      })

      const activity = Effect.fn('Stats.activity')(function* (id: number) {
        const [row] = yield* all<
          Omit<ActivityView, 'on_foot' | 'zones' | 'route' | 'minutes' | 'splits' | 'laps'> & {
            on_foot: number
            polyline: string | null
            hr_z1_s: number | null
            hr_z2_s: number | null
            hr_z3_s: number | null
            hr_z4_s: number | null
            hr_z5_s: number | null
          }
        >(
          sql`
          SELECT id, day, start_local, name, sport, ${sql.raw(ON_FOOT)} AS on_foot,
            round(distance_m / 1000, 2) AS distance_km, ${sql.raw(TIME)} AS moving_s, elapsed_s,
            ${sql.raw(PACE)} AS pace_s, ${sql.raw(SPEED)} AS speed_kmh, avg_hr, max_hr, round(ascent_m) AS ascent_m,
            round(descent_m) AS descent_m, round(avg_cadence) AS cadence, avg_power, calories,
            round(training_load) AS training_load, aerobic_te, anaerobic_te, te_label, vo2max, rpe,
            workout_name, gear, device, polyline, hr_z1_s, hr_z2_s, hr_z3_s, hr_z4_s, hr_z5_s
          FROM activities WHERE id = ${Math.trunc(id)}`
        )
        if (row === undefined) return null
        const laps = yield* all<Lap>(sql`
          SELECT idx + 1 AS lap, round(distance_m) AS distance_m, moving_s,
            ${sql.raw(PACE)} AS pace_s, ${sql.raw(SPEED)} AS speed_kmh,
            avg_hr, max_hr, round(avg_cadence) AS cadence, round(ascent_m) AS ascent_m, intensity
          FROM laps WHERE activity_id = ${row.id} ORDER BY idx`)
        const samples = yield* all<SamplePoint>(sql`
          SELECT t, hr, speed, cadence, alt, distance, power FROM samples
          WHERE activity_id = ${row.id} ORDER BY t`)
        const {
          on_foot: onFoot,
          polyline,
          hr_z1_s: z1,
          hr_z2_s: z2,
          hr_z3_s: z3,
          hr_z4_s: z4,
          hr_z5_s: z5,
          ...rest
        } = row
        const zoned = [z1, z2, z3, z4, z5].some((value) => value !== null && value > 0)
        return {
          ...rest,
          on_foot: onFoot === 1,
          decoupling_pct: decoupling(samples),
          zones: zoned
            ? { z1_s: z1 ?? 0, z2_s: z2 ?? 0, z3_s: z3 ?? 0, z4_s: z4 ?? 0, z5_s: z5 ?? 0 }
            : null,
          route: polyline === null ? [] : decode(polyline),
          minutes: minutesOf(samples),
          splits: kmSplits(samples),
          laps,
        } satisfies ActivityView
      })

      const NIGHT = sql`day, sleep_start, sleep_end, sleep_s, deep_s, light_s, rem_s, awake_s,
        nap_s, sleep_score, hrv, hrv_weekly, hrv_status, hrv_baseline_low, hrv_baseline_high,
        resting_hr, respiration_avg, spo2_avg, body_battery_charged, body_battery_wake`
      type NightRow = Omit<SleepNight, 'bed_min' | 'wake_min'>
      const nightsBetween = (from: string, to: string) =>
        Effect.map(
          all<NightRow>(
            sql`SELECT ${NIGHT} FROM daily WHERE day BETWEEN ${from} AND ${to} ORDER BY day`
          ),
          (rows) => rows.map((night) => withClock(night))
        )
      const emptyNight = (day: string): SleepNight => ({
        day,
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
      })

      const sleep = Effect.fn('Stats.sleep')(function* (days: number) {
        const span = Math.max(7, Math.min(Math.trunc(days), 366))
        const today = yield* parisToday
        const from = addDays(today, -(span - 1))
        const rows = yield* nightsBetween(from, today)
        const previous = yield* nightsBetween(addDays(from, -span), addDays(from, -1))
        const byDay = new Map(rows.map((night) => [night.day, night]))
        const nights = Array.from({ length: span }, (_, index) => {
          const day = addDays(from, index)
          return byDay.get(day) ?? emptyNight(day)
        })
        const [last] = yield* all<NightRow>(sql`
          SELECT ${NIGHT} FROM daily WHERE sleep_s IS NOT NULL ORDER BY day DESC LIMIT 1`)
        return {
          today,
          days: span,
          last: last === undefined ? null : withClock(last),
          nights,
          averages: sleepAverages(rows),
          previous: sleepAverages(previous),
        } satisfies SleepView
      })

      return Stats.of({ dashboard, runs, activity, sleep })
    })
  )
}
