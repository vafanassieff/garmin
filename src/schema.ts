import { sql } from 'drizzle-orm'
import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  sqliteView,
  text,
} from 'drizzle-orm/sqlite-core'

// The schema; `pnpm db:generate <name>` writes its next migration into drizzle/. Every row is
// rebuilt from the raw files of data/ (see ingest.ts), so a column can always be added and filled
// by `pnpm ingest --rebuild`. Timestamps are ISO 8601 UTC text, local times
// YYYY-MM-DDTHH:MM:SS text, days YYYY-MM-DD (the watch's local day). Metres, seconds, m/s, bpm.

const now = sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`

// One per Garmin Connect activity, from its FIT file (fit.ts) and its Connect summary (connect.ts):
// either may be missing (a manual activity has no FIT file; an exported FIT file no summary)
export const activities = sqliteTable(
  'activities',
  {
    // Garmin Connect's activity id
    id: integer().primaryKey(),
    name: text(),
    // Connect's activity type (running, trail_running, cycling, lap_swimming…),
    // else the FIT file's sport
    sport: text().notNull(),
    fit_sport: text(),
    fit_sub_sport: text(),
    start_time: text().notNull(),
    start_local: text().notNull(),
    day: text().notNull(),
    elapsed_s: real(),
    // Timer time (pauses excluded), Connect's moving duration when it has one
    moving_s: real(),
    distance_m: real(),
    ascent_m: real(),
    descent_m: real(),
    avg_hr: integer(),
    max_hr: integer(),
    avg_speed: real(),
    max_speed: real(),
    // Steps per minute on foot, revolutions per minute on a bike
    avg_cadence: real(),
    max_cadence: real(),
    avg_power: integer(),
    max_power: integer(),
    norm_power: integer(),
    calories: integer(),
    // Garmin's training load (EPOC), aerobic and anaerobic training effect (0-5)
    training_load: real(),
    aerobic_te: real(),
    anaerobic_te: real(),
    te_label: text(),
    vo2max: real(),
    // The perceived effort and feel entered on the watch after the activity (0-10, 0-100)
    rpe: real(),
    feel: integer(),
    // Seconds in each of the watch's HR zones; hr_zone_bounds is its JSON array of zone top
    // bounds [z0, z1, z2, z3, z4, z5] (z1 is from z0's top to z1's)
    hr_z1_s: real(),
    hr_z2_s: real(),
    hr_z3_s: real(),
    hr_z4_s: real(),
    hr_z5_s: real(),
    hr_zone_bounds: text(),
    // The structured workout the watch ran, if any (its name as in the calendar)
    workout_name: text(),
    gear: text(),
    device: text(),
    start_lat: real(),
    start_lon: real(),
    // Google encoded polyline (precision 5) of the route simplified to ~5 m, for maps
    polyline: text(),
    // Relative to data/
    fit_file: text(),
    summary_file: text(),
    updated_at: text().notNull().default(now),
  },
  (table) => [index('activities_day').on(table.day), index('activities_sport').on(table.sport)]
)

// The FIT file's laps, in order
export const laps = sqliteTable(
  'laps',
  {
    activity_id: integer()
      .notNull()
      .references(() => activities.id, { onDelete: 'cascade' }),
    idx: integer().notNull(),
    start_time: text().notNull(),
    elapsed_s: real(),
    moving_s: real(),
    distance_m: real(),
    avg_hr: integer(),
    max_hr: integer(),
    avg_speed: real(),
    max_speed: real(),
    avg_cadence: real(),
    avg_power: integer(),
    ascent_m: real(),
    descent_m: real(),
    // active, rest, warmup, cooldown, recovery…
    intensity: text(),
    // manual, distance, time, position… (what closed the lap)
    trigger: text(),
    // The workout step it ran (0-based), for a structured workout
    workout_step: integer(),
  },
  (table) => [primaryKey({ columns: [table.activity_id, table.idx] })]
)

// The FIT file's records, one per second at most (the last of a second wins): t is seconds since
// the activity's start. WITHOUT ROWID (added to its migration by hand: drizzle has no option for
// it), the rows clustered by activity.
export const samples = sqliteTable(
  'samples',
  {
    activity_id: integer()
      .notNull()
      .references(() => activities.id, { onDelete: 'cascade' }),
    t: integer().notNull(),
    lat: real(),
    lon: real(),
    alt: real(),
    hr: integer(),
    speed: real(),
    cadence: real(),
    power: integer(),
    distance: real(),
  },
  (table) => [primaryKey({ columns: [table.activity_id, table.t] })]
)

// One per day, from Garmin Connect's daily files (and the export's): the sleep is the night ending
// that morning, as in Garmin Connect
export const daily = sqliteTable('daily', {
  day: text().primaryKey(),
  sleep_start: text(),
  sleep_end: text(),
  sleep_s: integer(),
  deep_s: integer(),
  light_s: integer(),
  rem_s: integer(),
  awake_s: integer(),
  nap_s: integer(),
  sleep_score: integer(),
  // Overnight HRV (ms, rMSSD), its 7-day average, Garmin's status and baseline band
  hrv: real(),
  hrv_weekly: real(),
  hrv_status: text(),
  hrv_baseline_low: real(),
  hrv_baseline_high: real(),
  resting_hr: integer(),
  min_hr: integer(),
  max_hr: integer(),
  body_battery_high: integer(),
  body_battery_low: integer(),
  body_battery_wake: integer(),
  body_battery_charged: integer(),
  body_battery_drained: integer(),
  steps: integer(),
  distance_m: real(),
  active_kcal: integer(),
  total_kcal: integer(),
  stress_avg: integer(),
  stress_max: integer(),
  intensity_moderate_min: integer(),
  intensity_vigorous_min: integer(),
  respiration_avg: real(),
  spo2_avg: real(),
  // The morning's training readiness (after waking, else the day's first)
  readiness: integer(),
  readiness_level: text(),
  readiness_feedback: text(),
  recovery_time_h: integer(),
  acute_load: real(),
  chronic_load: real(),
  training_status: text(),
  // Measured that day only (null on the other days)
  vo2max: real(),
  vo2max_cycling: real(),
  // Garmin's race predictions (seconds)
  race_5k_s: integer(),
  race_10k_s: integer(),
  race_half_s: integer(),
  race_marathon_s: integer(),
  updated_at: text().notNull().default(now),
})

// Weigh-ins (a body composition scale or entered by hand)
export const body = sqliteTable(
  'body',
  {
    time: text().primaryKey(),
    day: text().notNull(),
    weight_kg: real(),
    bmi: real(),
    body_fat_pct: real(),
    body_water_pct: real(),
    muscle_mass_kg: real(),
    bone_mass_kg: real(),
    visceral_fat: real(),
    source: text(),
  },
  (table) => [index('body_day').on(table.day)]
)

// The Garmin calendar's scheduled workouts
export const plannedWorkouts = sqliteTable(
  'planned_workouts',
  {
    // The calendar item's id
    id: integer().primaryKey(),
    day: text().notNull(),
    workout_id: integer(),
    name: text().notNull(),
    sport: text(),
    description: text(),
    estimated_duration_s: integer(),
    estimated_distance_m: real(),
    // One line per step, readable (see connect.ts)
    steps: text(),
  },
  (table) => [index('planned_workouts_day').on(table.day)]
)

// Every file of data/ ingested: one whose size and mtime have not changed is not read again
export const rawFiles = sqliteTable('raw_files', {
  path: text().primaryKey(),
  size: integer().notNull(),
  mtime_ms: integer().notNull(),
  ingested_at: text().notNull().default(now),
  // Why it could not be ingested (it is tried again once it changes)
  error: text(),
})

// Every sync with Garmin Connect (see garmin/sync.ts): when, as whom, from which day, what it wrote
// and what failed. logged_out: Garmin refused the session, someone has to log in again.
export const syncRuns = sqliteTable(
  'sync_runs',
  {
    id: integer().primaryKey({ autoIncrement: true }),
    started_at: text().notNull(),
    finished_at: text(),
    // null while it runs
    ok: integer({ mode: 'boolean' }),
    logged_out: integer({ mode: 'boolean' }).notNull().default(false),
    account: text(),
    since: text(),
    files_written: integer(),
    // JSON: the calls that failed without stopping the sync, 20 at most
    warnings: text(),
    error: text(),
  },
  (table) => [index('sync_runs_started').on(table.started_at)]
)

// For the MCP's SQL: one row per activity, in the units Garmin Connect shows
export const activitySummary = sqliteView('activity_summary', {
  id: integer().notNull(),
}).as(sql`
  SELECT id, day, start_local, sport, name,
    round(distance_m / 1000, 2) AS distance_km,
    round(moving_s / 60, 1) AS moving_min,
    round(elapsed_s / 60, 1) AS elapsed_min,
    CASE WHEN avg_speed > 0 AND (sport LIKE '%running%' OR sport IN ('walking', 'hiking'))
      THEN printf('%d:%02d', CAST(round(1000 / avg_speed) AS INTEGER) / 60,
        CAST(round(1000 / avg_speed) AS INTEGER) % 60) END AS pace_min_km,
    round(avg_speed * 3.6, 1) AS speed_kmh,
    avg_hr, max_hr, round(ascent_m) AS ascent_m, round(avg_cadence) AS cadence,
    avg_power, round(training_load) AS training_load, aerobic_te, anaerobic_te, te_label,
    round(hr_z1_s / 60, 1) AS z1_min, round(hr_z2_s / 60, 1) AS z2_min,
    round(hr_z3_s / 60, 1) AS z3_min, round(hr_z4_s / 60, 1) AS z4_min,
    round(hr_z5_s / 60, 1) AS z5_min,
    rpe, workout_name, gear
  FROM activities
`)

// Per ISO week (week = its Monday) and sport
export const weekly = sqliteView('weekly', {
  week: text().notNull(),
}).as(sql`
  SELECT date(day, '-6 days', 'weekday 1') AS week, sport,
    count(*) AS activities,
    round(sum(distance_m) / 1000, 1) AS distance_km,
    round(sum(moving_s) / 3600, 2) AS moving_h,
    round(sum(ascent_m)) AS ascent_m,
    round(sum(training_load)) AS training_load,
    round(max(distance_m) / 1000, 1) AS longest_km,
    round(sum(coalesce(hr_z4_s, 0) + coalesce(hr_z5_s, 0)) / 60) AS z4_z5_min
  FROM activities
  GROUP BY 1, 2
`)
