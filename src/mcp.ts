import { Effect, Layer, Schema } from 'effect'
import { McpProtocol, McpServer, Tool, Toolkit } from 'effect/ai'

import { GarminLogin } from './garmin/login.ts'
import { MAX_ROWS, QueryError, Reader } from './reader.ts'
import { Tools } from './tools.ts'

const DATA_MODEL = `Data: the user's Garmin history (watch, scale): every activity from its FIT file (laps, per-second samples) and Garmin Connect's summary, plus daily wellness (sleep, HRV, resting HR, body battery, readiness), weigh-ins and the Garmin calendar's planned workouts. Synced from Garmin Connect every 3 hours (sync_status tells when). Read-only.
Conventions: timestamps ISO 8601 UTC text, start_local local wall time, day YYYY-MM-DD (local). Metres, seconds, m/s, bpm, kg. Cadence is steps/min on foot, rpm on a bike.
Tables and views:
- activities: one row per Garmin Connect activity (id = its activity id). sport (Connect's type: running, trail_running, cycling, lap_swimming, hiking, strength_training…), name, start_time, start_local, day, elapsed_s, moving_s, distance_m, ascent_m, descent_m, avg_hr, max_hr, avg_speed, max_speed, avg_cadence, max_cadence, avg_power, max_power, norm_power, calories, training_load (Garmin's EPOC load), aerobic_te / anaerobic_te (training effect 0-5), te_label (TEMPO, BASE…), vo2max, rpe (0-10) and feel (0-100) entered after it, hr_z1_s…hr_z5_s (seconds in the watch's HR zones), hr_zone_bounds (JSON: the zones' top bounds [z0, z1…z5]), workout_name (the structured workout run, as in planned_workouts.name), gear, device, start_lat/start_lon, polyline (Google encoded, precision 5).
- activity_summary (view): the same in Connect's units: distance_km, moving_min, pace_min_km (m:ss, on foot), speed_kmh, z1_min…z5_min. Use it to list activities.
- laps: activity_id, idx (0-based), start_time, elapsed_s, moving_s, distance_m, avg_hr, max_hr, avg_speed, max_speed, avg_cadence, avg_power, ascent_m, descent_m, intensity (active, rest, warmup, cooldown), trigger (manual, distance…), workout_step.
- samples: per second: activity_id, t (seconds from start), lat, lon, alt, hr, speed, cadence, power, distance (cumulative m). Large: always filter by activity_id.
- daily: one row per day. Sleep is the night ending that morning: sleep_start, sleep_end, sleep_s, deep_s, light_s, rem_s, awake_s, nap_s, sleep_score; hrv (overnight average, ms), hrv_weekly, hrv_status (BALANCED, UNBALANCED, LOW…), hrv_baseline_low/high; resting_hr, min_hr, max_hr; body_battery_high/low/wake/charged/drained; steps, distance_m, active_kcal, total_kcal; stress_avg, stress_max; intensity_moderate_min, intensity_vigorous_min; respiration_avg, spo2_avg; readiness (the morning's training readiness 0-100), readiness_level, readiness_feedback, recovery_time_h, acute_load (Garmin's 7-day acute load); chronic_load, training_status; vo2max / vo2max_cycling (only on days measured); race_5k_s, race_10k_s, race_half_s, race_marathon_s (Garmin's predictions).
- weekly (view): per ISO week (week = Monday) and sport: activities, distance_km, moving_h, ascent_m, training_load, longest_km, z4_z5_min.
- body: weigh-ins: time, day, weight_kg, bmi, body_fat_pct, body_water_pct, muscle_mass_kg, bone_mass_kg, visceral_fat, source.
- planned_workouts: the Garmin calendar's scheduled workouts: id, day, workout_id, name, sport, description, estimated_duration_s, estimated_distance_m, steps (one readable line per step: "interval 3:00 HR 165-172", "5× [...]").
- raw_files: the source files ingested (path, error).
- sync_runs: each sync with Garmin Connect: started_at, finished_at, ok, logged_out, account, since, files_written, warnings (JSON), error.`

const QUERY_GUIDE = `SQLite tips:
- Runs of the last 30 days: SELECT * FROM activity_summary WHERE sport LIKE '%running%' AND day >= date('now', '-30 days') ORDER BY day DESC
- Weekly running km: SELECT week, distance_km FROM weekly WHERE sport = 'running' ORDER BY week DESC
- One run's km at a glance: SELECT CAST(distance / 1000 AS INT) AS km, min(t), max(t), avg(hr) FROM samples WHERE activity_id = ? GROUP BY 1
- Pace from a speed: 1000 / speed seconds per km. Dates: date(), strftime('%Y-%W', day), julianday().
- One statement per call. Results are capped at ${MAX_ROWS} rows: aggregate instead of listing samples.`

export class ToolError extends Schema.TaggedError<ToolError>()('ToolError', {
  message: Schema.String,
}) {}

const Day = Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/u)).annotate({
  description: 'YYYY-MM-DD',
})

const ListActivities = Tool.make('list_activities', {
  description:
    'List activities, newest first: day, sport, name, distance, moving time, pace, HR, ascent, cadence, training load, training effect, minutes per HR zone, workout name.',
  parameters: Schema.Struct({
    from: Schema.optional(Day),
    to: Schema.optional(Day),
    sport: Schema.optional(
      Schema.String.annotate({
        description: 'Part of the sport key, e.g. running, cycling, climbing',
      })
    ),
    limit: Schema.optional(Schema.Number.annotate({ description: 'Default 30, at most 500' })),
  }),
  success: Schema.Unknown,
  failure: ToolError,
  failureMode: 'return',
})
  .annotate(Tool.Title, 'List activities')
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, false)

const GetActivity = Tool.make('get_activity', {
  description:
    "One activity in full: its summary, laps (pace, HR, cadence, climb, intensity, workout step), splits per km from the samples, HR zones and their bounds, aerobic decoupling (Pa:HR drift, %, under 5 = steady aerobic effort), the route's encoded polyline. samples: 'minute' adds a per-minute series (HR, pace, cadence, altitude, power).",
  parameters: Schema.Struct({
    id: Schema.Number.annotate({ description: 'The activity id (list_activities)' }),
    samples: Schema.optional(Schema.Literals(['none', 'minute'])),
  }),
  success: Schema.Unknown,
  failure: ToolError,
  failureMode: 'return',
})
  .annotate(Tool.Title, 'Get an activity')
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, false)

const CompareRuns = Tool.make('compare_runs', {
  description:
    'Compare activities side by side (typically runs): pace, HR, cadence, climb, load, minutes per HR zone, efficiency (metres per minute per heartbeat: higher is fitter at the same effort), aerobic decoupling (%) and splits per km.',
  parameters: Schema.Struct({
    ids: Schema.Array(Schema.Number).annotate({ description: 'Activity ids, 2 to 10' }),
  }),
  success: Schema.Unknown,
  failure: ToolError,
  failureMode: 'return',
})
  .annotate(Tool.Title, 'Compare runs')
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, false)

const DailyReadiness = Tool.make('daily_readiness', {
  description:
    "Recovery for a morning go/no-go: per day (newest first) sleep (hours, score, bedtime, wake), overnight HRV and its weekly average, status and baseline band, resting HR, body battery, Garmin's training readiness, acute load and stress; the 28-day baseline before the window; the activities of the last 3 days; the workouts planned today and tomorrow.",
  parameters: Schema.Struct({
    day: Schema.optional(Day.annotate({ description: 'YYYY-MM-DD, default today (Paris)' })),
    days: Schema.optional(Schema.Number.annotate({ description: 'Days in the window, default 7' })),
  }),
  success: Schema.Unknown,
  failure: ToolError,
  failureMode: 'return',
})
  .annotate(Tool.Title, 'Daily readiness')
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, false)

const WeeklyLoad = Tool.make('weekly_load', {
  description:
    "Training volume per ISO week (newest first): activities, km, hours, ascent, training load, longest activity, minutes in HR zones 1-2 / 3 / 4-5; with the acute (7 days) and chronic (weekly mean of 28 days) training load of every sport and their ratio, and Garmin's own acute load.",
  parameters: Schema.Struct({
    weeks: Schema.optional(Schema.Number.annotate({ description: 'Default 12' })),
    sport: Schema.optional(
      Schema.String.annotate({ description: 'Part of the sport key; every sport by default' })
    ),
  }),
  success: Schema.Unknown,
  failure: ToolError,
  failureMode: 'return',
})
  .annotate(Tool.Title, 'Weekly load')
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, false)

const PlannedWorkouts = Tool.make('planned_workouts', {
  description:
    "The Garmin calendar's scheduled workouts with their steps (durations, HR and pace targets), and the ids of the activities that ran them.",
  parameters: Schema.Struct({
    from: Schema.optional(Day.annotate({ description: 'Default today' })),
    to: Schema.optional(Day.annotate({ description: 'Default from + 14 days' })),
  }),
  success: Schema.Unknown,
  failure: ToolError,
  failureMode: 'return',
})
  .annotate(Tool.Title, 'Planned workouts')
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, false)

const SyncStatus = Tool.make('sync_status', {
  description:
    "Whether the data is fresh: the Garmin session (logged in, as whom, until when its token runs before a refresh), the sync's last runs (when, files written, warnings, error; logged_out: Garmin refused the session, the user must log in again at /garmin on the web app), when it last succeeded, the latest activity, night and weigh-in stored, the files that could not be read. Check it when data looks missing or stale.",
  success: Schema.Unknown,
  failure: ToolError,
  failureMode: 'return',
})
  .annotate(Tool.Title, 'Sync status')
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, false)

const SchemaTool = Tool.make('schema', {
  description: `List the tables and views with their columns.\n\n${DATA_MODEL}`,
  success: Schema.Record(
    Schema.String,
    Schema.Array(
      Schema.Struct({ column: Schema.String, type: Schema.String, nullable: Schema.Boolean })
    )
  ),
  failure: QueryError,
  failureMode: 'return',
})
  .annotate(Tool.Title, 'Garmin data schema')
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, false)

const SqlTool = Tool.make('sql', {
  description: `Run one read-only SQLite statement on the user's Garmin data and return the rows as JSON. Prefer the typed tools; use this for anything they do not answer.\n\n${DATA_MODEL}\n\n${QUERY_GUIDE}`,
  parameters: Schema.Struct({
    query: Schema.String.annotate({ description: 'A single read-only SQL statement' }),
  }),
  success: Schema.Struct({ rows: Schema.Unknown, note: Schema.optional(Schema.String) }),
  failure: QueryError,
  failureMode: 'return',
})
  .annotate(Tool.Title, 'Query Garmin data')
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, false)

export const GarminToolkit = Toolkit.make(
  ListActivities,
  GetActivity,
  CompareRuns,
  DailyReadiness,
  WeeklyLoad,
  PlannedWorkouts,
  SyncStatus,
  SchemaTool,
  SqlTool
)

export const capRows = (
  {
    rows,
    total,
  }: { readonly rows: ReadonlyArray<Record<string, unknown>>; readonly total: number },
  maxRows = MAX_ROWS
) =>
  total > maxRows
    ? {
        rows: rows.slice(0, maxRows),
        note: `Truncated to ${maxRows} of ${total} rows. Aggregate or add a LIMIT.`,
      }
    : { rows }

// A database failure as the tool's error, for the model to read
const orToolError = <A, E extends { readonly message?: string }, R>(
  effect: Effect.Effect<A, E, R>
) =>
  Effect.mapError(effect, (error) => new ToolError({ message: error.message ?? 'Database error' }))

const ToolkitHandlers = GarminToolkit.toLayer(
  Effect.gen(function* () {
    const reader = yield* Reader
    const tools = yield* Tools
    const garmin = yield* GarminLogin
    return GarminToolkit.of({
      list_activities: (options) => orToolError(tools.listActivities(options)),
      get_activity: (options) =>
        orToolError(tools.getActivity(options)).pipe(
          Effect.flatMap((activity) =>
            activity === null
              ? Effect.fail(new ToolError({ message: `No activity ${options.id}.` }))
              : Effect.succeed(activity)
          )
        ),
      compare_runs: ({ ids }) =>
        ids.length === 0 || ids.length > 10
          ? Effect.fail(new ToolError({ message: 'Compare 1 to 10 activities.' }))
          : orToolError(tools.compareRuns(ids)),
      daily_readiness: (options) => orToolError(tools.dailyReadiness(options)),
      weekly_load: (options) => orToolError(tools.weeklyLoad(options)),
      planned_workouts: (options) => orToolError(tools.plannedWorkouts(options)),
      sync_status: () =>
        orToolError(tools.syncStatus).pipe(
          Effect.flatMap((status) =>
            Effect.map(garmin.status, (session) => ({ garmin_session: session, ...status }))
          )
        ),
      schema: () =>
        reader.columns.pipe(
          Effect.map((columns) => {
            const tables: Record<
              string,
              Array<{ column: string; type: string; nullable: boolean }>
            > = {}
            for (const column of columns) {
              const table = tables[column.table_name] ?? []
              table.push({
                column: column.column_name,
                type: column.data_type,
                nullable: column.not_null === 0,
              })
              tables[column.table_name] = table
            }
            return tables
          })
        ),
      sql: ({ query }) => reader.query(query).pipe(Effect.map((result) => capRows(result))),
    })
  })
)

// Streamable HTTP at /mcp, behind the password (see auth.ts)
export const Mcp = McpServer.toolkit(GarminToolkit).pipe(
  Layer.provide(ToolkitHandlers),
  Layer.provideMerge(
    McpServer.layerHttp({
      name: 'garmin',
      version: '1.0.0',
      path: '/mcp',
      protocols: [McpProtocol.v2025_11_25, McpProtocol.v2025_06_18, McpProtocol.v2025_03_26],
    })
  )
)
