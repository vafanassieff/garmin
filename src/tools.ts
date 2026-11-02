import { sql, type SQL } from 'drizzle-orm'
import { Context, DateTime, Effect, Layer, Option } from 'effect'

import { Database, type DatabaseError } from './db.ts'

// The typed MCP tools' answers (see mcp.ts): plain rows, in the units Garmin Connect shows

type Row = Record<string, unknown>

export interface Split {
  readonly km: number
  // The last split is partial: its distance in km
  readonly distance_km: number
  readonly time: string
  readonly pace: string
  readonly avg_hr: number | null
  readonly max_hr: number | null
  readonly cadence: number | null
  readonly ascent_m: number
  readonly descent_m: number
}

export interface SamplePoint {
  readonly t: number
  readonly hr: number | null
  readonly speed: number | null
  readonly cadence: number | null
  readonly alt: number | null
  readonly distance: number | null
  readonly power: number | null
}

export const clock = (seconds: number) => {
  const whole = Math.round(seconds)
  const h = Math.floor(whole / 3600)
  const m = Math.floor((whole % 3600) / 60)
  const s = String(whole % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`
}

const mean = (values: ReadonlyArray<number>) =>
  values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length
const round = (value: number | null, digits = 0) =>
  value === null ? null : Number(value.toFixed(digits))
const numbers = (values: ReadonlyArray<number | null>) =>
  values.filter((value): value is number => value !== null)

// Samples further apart than this, the timer was paused between them: 10 s for a watch that
// records every second, 30 s with smart recording (a sample every few seconds, gaps up to ~20 s
// while moving)
const pauseAfter = (samples: ReadonlyArray<SamplePoint>) => {
  const gaps: Array<number> = []
  for (let index = 1; index < samples.length; index += 1) {
    gaps.push((samples[index]?.t ?? 0) - (samples[index - 1]?.t ?? 0))
  }
  gaps.sort((a, b) => a - b)
  return (gaps[Math.floor(gaps.length / 2)] ?? 1) <= 1 ? 10 : 30
}

// Per kilometre from the samples' distance: time (pauses excluded), pace, HR, cadence, climb
export const kmSplits = (samples: ReadonlyArray<SamplePoint>): Array<Split> => {
  const splits: Array<Split> = []
  const pause = pauseAfter(samples)
  let first = 0
  const close = (last: number, km: number, distance: number) => {
    const part = samples.slice(first, last + 1)
    const start = samples[first]
    const end = samples[last]
    if (start === undefined || end === undefined || distance <= 0) return
    // The timer's time: a gap in the samples longer than `pause` is a pause, not running
    let seconds = 0
    for (let index = 1; index < part.length; index += 1) {
      const gap = (part[index]?.t ?? 0) - (part[index - 1]?.t ?? 0)
      if (gap <= pause) seconds += gap
    }
    let ascent = 0
    let descent = 0
    for (let index = 1; index < part.length; index += 1) {
      const delta = (part[index]?.alt ?? 0) - (part[index - 1]?.alt ?? 0)
      if (part[index]?.alt === null || part[index - 1]?.alt === null) continue
      if (delta > 0) ascent += delta
      else descent -= delta
    }
    const hrs = numbers(part.map((s) => s.hr))
    splits.push({
      km,
      distance_km: round(distance / 1000, 2) ?? 0,
      time: clock(seconds),
      pace: clock(seconds / (distance / 1000)),
      avg_hr: round(mean(hrs)),
      max_hr: hrs.length === 0 ? null : Math.max(...hrs),
      cadence: round(mean(numbers(part.map((s) => s.cadence)).filter((c) => c > 0))),
      ascent_m: Math.round(ascent),
      descent_m: Math.round(descent),
    })
    first = last
  }
  let km = 1
  let lastDistance = 0
  for (let index = 0; index < samples.length; index += 1) {
    const distance = samples[index]?.distance
    if (distance === null || distance === undefined) continue
    lastDistance = distance
    if (distance >= km * 1000) {
      close(index, km, 1000)
      km += 1
    }
  }
  const covered = lastDistance - (km - 1) * 1000
  if (covered >= 50) close(samples.length - 1, km, covered)
  return splits
}

// Aerobic decoupling (Pa:HR): how much the speed per heartbeat drops from the first half of the
// moving time to the second, in %. Under 5 %: the effort was aerobic, the pace held without drift.
export const decoupling = (samples: ReadonlyArray<SamplePoint>) => {
  const moving = samples.filter(
    (s) => s.speed !== null && s.speed > 0.5 && s.hr !== null && s.hr > 0
  )
  if (moving.length < 600) return null
  const half = Math.floor(moving.length / 2)
  const ratio = (part: ReadonlyArray<SamplePoint>) =>
    (mean(numbers(part.map((s) => s.speed))) ?? 0) / (mean(numbers(part.map((s) => s.hr))) ?? 1)
  const first = ratio(moving.slice(0, half))
  const second = ratio(moving.slice(half))
  return first === 0 ? null : round(((first - second) / first) * 100, 1)
}

// A minute's average: what a chart of the activity needs, a 60th of the rows
export const perMinute = (samples: ReadonlyArray<SamplePoint>) => {
  const minutes = new Map<number, Array<SamplePoint>>()
  for (const sample of samples) {
    const minute = Math.floor(sample.t / 60)
    minutes.set(minute, [...(minutes.get(minute) ?? []), sample])
  }
  return [...minutes].map(([minute, part]) => ({
    minute,
    hr: round(mean(numbers(part.map((s) => s.hr)))),
    pace:
      (mean(numbers(part.map((s) => s.speed))) ?? 0) > 0.3
        ? clock(1000 / (mean(numbers(part.map((s) => s.speed))) ?? 1))
        : null,
    cadence: round(mean(numbers(part.map((s) => s.cadence)))),
    alt: round(mean(numbers(part.map((s) => s.alt))), 1),
    power: round(mean(numbers(part.map((s) => s.power)))),
    distance_km: round((part.at(-1)?.distance ?? 0) / 1000, 2),
  }))
}

// Today in Paris time, the user's days
export const parisToday = Effect.map(DateTime.now, (now) =>
  DateTime.makeZoned(now, { timeZone: 'Europe/Paris' }).pipe(
    Option.map(DateTime.formatIsoDate),
    Option.getOrElse(() => DateTime.formatIsoDate(now))
  )
)

const addDays = (day: string, days: number) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10)

export class Tools extends Context.Service<
  Tools,
  {
    readonly listActivities: (options: {
      readonly from?: string | undefined
      readonly to?: string | undefined
      readonly sport?: string | undefined
      readonly limit?: number | undefined
    }) => Effect.Effect<ReadonlyArray<Row>, DatabaseError>
    readonly getActivity: (options: {
      readonly id: number
      readonly samples?: 'none' | 'minute' | undefined
    }) => Effect.Effect<Row | null, DatabaseError>
    readonly compareRuns: (
      ids: ReadonlyArray<number>
    ) => Effect.Effect<ReadonlyArray<Row>, DatabaseError>
    readonly dailyReadiness: (options: {
      readonly day?: string | undefined
      readonly days?: number | undefined
    }) => Effect.Effect<Row, DatabaseError>
    readonly weeklyLoad: (options: {
      readonly weeks?: number | undefined
      readonly sport?: string | undefined
    }) => Effect.Effect<Row, DatabaseError>
    readonly plannedWorkouts: (options: {
      readonly from?: string | undefined
      readonly to?: string | undefined
    }) => Effect.Effect<ReadonlyArray<Row>, DatabaseError>
    readonly syncStatus: Effect.Effect<Row, DatabaseError>
  }
>()('garmin/Tools') {
  static readonly layer = Layer.effect(
    Tools,
    Effect.gen(function* () {
      const { use } = yield* Database
      const all = <A = Row>(query: SQL) => use((db) => db.all<A>(query))

      const samplesOf = (id: number) =>
        all<SamplePoint>(
          sql`SELECT t, hr, speed, cadence, alt, distance, power FROM samples WHERE activity_id = ${id} ORDER BY t`
        )

      const listActivities = Effect.fn('Tools.listActivities')(function* (options: {
        readonly from?: string | undefined
        readonly to?: string | undefined
        readonly sport?: string | undefined
        readonly limit?: number | undefined
      }) {
        return yield* all(sql`
          SELECT * FROM activity_summary
          WHERE day >= ${options.from ?? '0000'} AND day <= ${options.to ?? '9999'}
            AND (${options.sport ?? null} IS NULL OR sport LIKE ${`%${options.sport ?? ''}%`})
          ORDER BY start_local DESC
          LIMIT ${Math.min(Math.max(Math.trunc(options.limit ?? 30), 1), 500)}`)
      })

      const getActivity = Effect.fn('Tools.getActivity')(function* (options: {
        readonly id: number
        readonly samples?: 'none' | 'minute' | undefined
      }) {
        const [activity] = yield* all(sql`
          SELECT s.*, a.start_time, a.elapsed_s, a.moving_s, a.distance_m, a.descent_m,
            a.avg_speed, a.max_speed, a.max_cadence, a.max_power, a.norm_power, a.calories,
            a.vo2max, a.feel, a.hr_zone_bounds, a.device, a.start_lat, a.start_lon, a.polyline,
            a.fit_sport, a.fit_sub_sport
          FROM activity_summary s JOIN activities a USING (id) WHERE id = ${options.id}`)
        if (activity === undefined) return null
        const laps = yield* all(sql`
          SELECT idx + 1 AS lap, round(distance_m) AS distance_m,
            printf('%d:%02d', CAST(moving_s AS INTEGER) / 60, CAST(moving_s AS INTEGER) % 60) AS time,
            CASE WHEN avg_speed > 0 THEN printf('%d:%02d', CAST(round(1000 / avg_speed) AS INTEGER) / 60,
              CAST(round(1000 / avg_speed) AS INTEGER) % 60) END AS pace,
            avg_hr, max_hr, round(avg_cadence) AS cadence, avg_power, round(ascent_m) AS ascent_m,
            round(descent_m) AS descent_m, intensity, trigger, workout_step
          FROM laps WHERE activity_id = ${options.id} ORDER BY idx`)
        const samples = yield* samplesOf(options.id)
        return {
          ...activity,
          decoupling_pct: decoupling(samples),
          laps,
          km_splits: kmSplits(samples),
          ...(options.samples === 'minute' ? { per_minute: perMinute(samples) } : {}),
        }
      })

      const compareRuns = Effect.fn('Tools.compareRuns')(function* (ids: ReadonlyArray<number>) {
        return yield* Effect.forEach(ids, (id) =>
          Effect.gen(function* () {
            const [activity] = yield* all(sql`
              SELECT s.id, s.day, s.name, s.sport, s.distance_km, s.moving_min, s.pace_min_km,
                s.avg_hr, s.max_hr, s.ascent_m, s.cadence, s.training_load, s.aerobic_te,
                s.z1_min, s.z2_min, s.z3_min, s.z4_min, s.z5_min, a.avg_speed
              FROM activity_summary s JOIN activities a USING (id) WHERE id = ${id}`)
            if (activity === undefined) return { id, error: 'no such activity' }
            const samples = yield* samplesOf(id)
            const { avg_speed: speed, avg_hr: hr, ...rest } = activity
            return {
              ...rest,
              avg_hr: hr,
              // Metres per minute per beat: higher is fitter at the same effort
              efficiency:
                typeof speed === 'number' && typeof hr === 'number' && hr > 0
                  ? round((speed * 60) / hr, 3)
                  : null,
              decoupling_pct: decoupling(samples),
              km_splits: kmSplits(samples),
            }
          })
        )
      })

      const dailyReadiness = Effect.fn('Tools.dailyReadiness')(function* (options: {
        readonly day?: string | undefined
        readonly days?: number | undefined
      }) {
        const day = options.day ?? (yield* parisToday)
        const first = addDays(day, -Math.max(1, Math.min(options.days ?? 7, 90)) + 1)
        const days = yield* all(sql`
          SELECT day, round(sleep_s / 3600.0, 2) AS sleep_h, sleep_score,
            strftime('%H:%M', sleep_start, 'localtime') AS bedtime,
            strftime('%H:%M', sleep_end, 'localtime') AS wake,
            hrv, hrv_weekly, hrv_status, hrv_baseline_low, hrv_baseline_high, resting_hr,
            body_battery_wake, body_battery_high, body_battery_low, readiness, readiness_level,
            readiness_feedback, recovery_time_h, acute_load, stress_avg, steps
          FROM daily WHERE day BETWEEN ${first} AND ${day} ORDER BY day DESC`)
        // The 28 days before the window: what normal is
        const [baseline] = yield* all(sql`
          SELECT round(avg(hrv), 1) AS hrv, round(avg(resting_hr), 1) AS resting_hr,
            round(avg(sleep_s) / 3600.0, 2) AS sleep_h, round(avg(sleep_score)) AS sleep_score,
            round(avg(body_battery_wake)) AS body_battery_wake, count(*) AS days
          FROM daily WHERE day BETWEEN ${addDays(first, -28)} AND ${addDays(first, -1)}`)
        const recent = yield* all(sql`
          SELECT day, sport, name, distance_km, moving_min, avg_hr, training_load, aerobic_te
          FROM activity_summary WHERE day BETWEEN ${addDays(day, -3)} AND ${day}
          ORDER BY start_local DESC`)
        const planned = yield* all(sql`
          SELECT day, name, sport, steps FROM planned_workouts
          WHERE day BETWEEN ${day} AND ${addDays(day, 1)} ORDER BY day`)
        return { day, days, baseline_28d: baseline ?? null, last_3_days: recent, planned }
      })

      const weeklyLoad = Effect.fn('Tools.weeklyLoad')(function* (options: {
        readonly weeks?: number | undefined
        readonly sport?: string | undefined
      }) {
        const today = yield* parisToday
        const weeks = Math.max(1, Math.min(options.weeks ?? 12, 104))
        const sport = options.sport ?? null
        const sportLike = `%${options.sport ?? ''}%`
        const from = addDays(today, -7 * weeks)
        const rows = yield* all(sql`
          SELECT date(day, '-6 days', 'weekday 1') AS week, count(*) AS activities,
            round(sum(distance_m) / 1000, 1) AS distance_km, round(sum(moving_s) / 3600, 2) AS moving_h,
            round(sum(ascent_m)) AS ascent_m, round(sum(training_load)) AS training_load,
            round(max(distance_m) / 1000, 1) AS longest_km,
            round(sum(coalesce(hr_z1_s, 0) + coalesce(hr_z2_s, 0)) / 60) AS z1_z2_min,
            round(sum(coalesce(hr_z3_s, 0)) / 60) AS z3_min,
            round(sum(coalesce(hr_z4_s, 0) + coalesce(hr_z5_s, 0)) / 60) AS z4_z5_min,
            group_concat(DISTINCT sport) AS sports
          FROM activities
          WHERE day > ${from} AND (${sport} IS NULL OR sport LIKE ${sportLike})
          GROUP BY 1 ORDER BY 1 DESC`)
        // Every sport: load is one body's
        const [load] = yield* all<{ acute: number | null; chronic: number | null }>(sql`
          SELECT
            (SELECT sum(training_load) FROM activities WHERE day > ${addDays(today, -7)}) AS acute,
            (SELECT sum(training_load) / 4.0 FROM activities WHERE day > ${addDays(today, -28)}) AS chronic`)
        const acute = load?.acute ?? null
        const chronic = load?.chronic ?? null
        return {
          today,
          weeks: rows,
          // Training load of the last 7 days, the weekly mean of the last 28, and their ratio
          // (0.8-1.3: building safely; above 1.5: a spike)
          acute_7d: round(acute),
          chronic_weekly_28d: round(chronic),
          acwr:
            acute === null || chronic === null || chronic === 0 ? null : round(acute / chronic, 2),
          garmin_acute_load:
            (yield* all(
              sql`SELECT day, acute_load FROM daily WHERE acute_load IS NOT NULL ORDER BY day DESC LIMIT 1`
            ))[0] ?? null,
        }
      })

      const plannedWorkouts = Effect.fn('Tools.plannedWorkouts')(function* (options: {
        readonly from?: string | undefined
        readonly to?: string | undefined
      }) {
        const today = yield* parisToday
        const from = options.from ?? today
        return yield* all(sql`
          SELECT p.id AS schedule_id, p.workout_id, p.day, p.name, p.sport, p.description,
            p.estimated_duration_s, p.steps,
            (SELECT group_concat(a.id) FROM activities a WHERE a.day = p.day AND a.workout_name = p.name) AS done_activity_ids
          FROM planned_workouts p
          WHERE p.day BETWEEN ${from} AND ${options.to ?? addDays(from, 14)} ORDER BY p.day`)
      })

      // The sync's last runs (a lost Garmin login shows here: logged_out) and how fresh the data is
      const syncStatus = Effect.gen(function* () {
        const runs = yield* all(sql`
          SELECT started_at, finished_at, ok, logged_out, account, since, files_written, error,
            json(warnings) AS warnings
          FROM sync_runs ORDER BY id DESC LIMIT 3`)
        const [freshness] = yield* all(sql`
          SELECT (SELECT max(finished_at) FROM sync_runs WHERE ok) AS last_success_at,
            (SELECT max(start_local) FROM activities) AS latest_activity,
            (SELECT max(day) FROM daily WHERE sleep_s IS NOT NULL) AS latest_sleep,
            (SELECT max(day) FROM body) AS latest_weigh_in,
            (SELECT max(ingested_at) FROM raw_files) AS last_ingest`)
        const errors = yield* all(
          sql`SELECT path, error FROM raw_files WHERE error IS NOT NULL ORDER BY path LIMIT 20`
        )
        return { ...freshness, last_runs: runs, ingest_errors: errors }
      })

      return Tools.of({
        syncStatus,
        listActivities,
        getActivity,
        compareRuns,
        dailyReadiness,
        weeklyLoad,
        plannedWorkouts,
      })
    })
  )
}
