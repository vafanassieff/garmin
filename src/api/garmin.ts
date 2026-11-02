import { ORPCError } from '@orpc/server'
import { Effect, Schema } from 'effect'

import { GarminLogin } from '../garmin/login.ts'
import { findExercises, WorkoutSchema } from '../garmin/workout-builder.ts'
import { GarminWorkouts } from '../garmin/workouts.ts'
import { MAX_ROWS, Reader } from '../reader.ts'
import { Tools } from '../tools.ts'

import { Day, standard, tool } from './base.ts'

// The Garmin data and the watch's workouts: each procedure an MCP tool (its name), an OpenAPI
// operation (under /api) and an RPC call (under /rpc). The tools' names and inputs are the MCP's.

const DATA_MODEL = `Data: the user's Garmin history (watch, scale): every activity from its FIT file (laps, per-second samples) and Garmin Connect's summary, plus daily wellness (sleep, HRV, resting HR, body battery, readiness), weigh-ins and the Garmin calendar's planned workouts. Synced from Garmin Connect every 3 hours (sync_status tells when). The SQL is read-only; the workout tools (create_workout, schedule_workout, unschedule_workout, delete_workout) write to the Garmin calendar and refresh planned_workouts right after.
Conventions: timestamps ISO 8601 UTC text, start_local local wall time, day YYYY-MM-DD (local). Metres, seconds, m/s, bpm, kg. Cadence is steps/min on foot, rpm on a bike.
Tables and views:
- activities: one row per Garmin Connect activity (id = its activity id). sport (Connect's type: running, trail_running, cycling, lap_swimming, hiking, strength_training…), name, start_time, start_local, day, elapsed_s, moving_s, distance_m, ascent_m, descent_m, avg_hr, max_hr, avg_speed, max_speed, avg_cadence, max_cadence, avg_power, max_power, norm_power, calories, training_load (Garmin's EPOC load), aerobic_te / anaerobic_te (training effect 0-5), te_label (TEMPO, BASE…), vo2max, rpe (0-10) and feel (0-100) entered after it, hr_z1_s…hr_z5_s (seconds in the watch's HR zones), hr_zone_bounds (JSON: the zones' top bounds [z0, z1…z5]), workout_name (the structured workout run, as in planned_workouts.name), gear, device, start_lat/start_lon, polyline (Google encoded, precision 5).
- activity_summary (view): the same in Connect's units: distance_km, moving_min, pace_min_km (m:ss, on foot), speed_kmh, z1_min…z5_min. Use it to list activities.
- laps: activity_id, idx (0-based), start_time, elapsed_s, moving_s, distance_m, avg_hr, max_hr, avg_speed, max_speed, avg_cadence, avg_power, ascent_m, descent_m, intensity (active, rest, warmup, cooldown), trigger (manual, distance…), workout_step.
- samples: per second: activity_id, t (seconds from start), lat, lon, alt, hr, speed, cadence, power, distance (cumulative m). Large: always filter by activity_id.
- daily: one row per day. Sleep is the night ending that morning: sleep_start, sleep_end, sleep_s, deep_s, light_s, rem_s, awake_s, nap_s, sleep_score; hrv (overnight average, ms), hrv_weekly, hrv_status (BALANCED, UNBALANCED, LOW…), hrv_baseline_low/high; resting_hr, min_hr, max_hr; body_battery_high/low/wake/charged/drained; steps, distance_m, active_kcal, total_kcal; stress_avg, stress_max; intensity_moderate_min, intensity_vigorous_min; respiration_avg, spo2_avg; readiness (the morning's training readiness 0-100), readiness_level, readiness_feedback, recovery_time_h, acute_load (Garmin's 7-day acute load); chronic_load, training_status; vo2max / vo2max_cycling (only on days measured); race_5k_s, race_10k_s, race_half_s, race_marathon_s (Garmin's predictions).
- weekly (view): per ISO week (week = Monday) and sport: activities, distance_km, moving_h, ascent_m, training_load, longest_km, z4_z5_min.
- body: weigh-ins: time, day, weight_kg, bmi, body_fat_pct, body_water_pct, muscle_mass_kg, bone_mass_kg, visceral_fat, source.
- planned_workouts: the Garmin calendar's scheduled workouts: id (the calendar entry: unschedule_workout's schedule_id), day, workout_id (the library's workout: schedule_workout, delete_workout), name, sport, description, estimated_duration_s, estimated_distance_m, steps (one readable line per step: "interval 3:00 HR 165-172", "5× [...]").
- raw_files: the source files ingested (path, error).
- sync_runs: each sync with Garmin Connect: started_at, finished_at, ok, logged_out, account, since, files_written, warnings (JSON), error.`

const QUERY_GUIDE = `SQLite tips:
- Runs of the last 30 days: SELECT * FROM activity_summary WHERE sport LIKE '%running%' AND day >= date('now', '-30 days') ORDER BY day DESC
- Weekly running km: SELECT week, distance_km FROM weekly WHERE sport = 'running' ORDER BY week DESC
- One run's km at a glance: SELECT CAST(distance / 1000 AS INT) AS km, min(t), max(t), avg(hr) FROM samples WHERE activity_id = ? GROUP BY 1
- Pace from a speed: 1000 / speed seconds per km. Dates: date(), strftime('%Y-%W', day), julianday().
- One statement per call. Results are capped at ${MAX_ROWS} rows: aggregate instead of listing samples.`

const WATCH =
  "It changes the user's real Garmin Connect account: the watch gets it at its next sync with the Garmin Connect app."

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

const Id = Schema.Int.check(Schema.isGreaterThan(0))
const opt = Schema.optionalKey

// --- The data (read-only)

const listActivities = tool({
  name: 'list_activities',
  title: 'List activities',
  description:
    'List activities, newest first: day, sport, name, distance, moving time, pace, HR, ascent, cadence, training load, training effect, minutes per HR zone, workout name.',
  method: 'GET',
  path: '/activities',
  tags: ['activities'],
  readOnly: true,
  openWorld: false,
})
  .input(
    standard(
      Schema.Struct({
        from: opt(Day),
        to: opt(Day),
        sport: opt(
          Schema.String.annotate({
            description: 'Part of the sport key, e.g. running, cycling, climbing',
          })
        ),
        limit: opt(Schema.Int.annotate({ description: 'Default 30, at most 500' })),
      })
    )
  )
  .handler(({ input, context }) => context.run(Tools.use((tools) => tools.listActivities(input))))

const getActivity = tool({
  name: 'get_activity',
  title: 'Get an activity',
  description:
    "One activity in full: its summary, laps (pace, HR, cadence, climb, intensity, workout step), splits per km from the samples, HR zones and their bounds, aerobic decoupling (Pa:HR drift, %, under 5 = steady aerobic effort), the route's encoded polyline. samples: 'minute' adds a per-minute series (HR, pace, cadence, altitude, power).",
  method: 'GET',
  path: '/activities/{id}',
  tags: ['activities'],
  readOnly: true,
  openWorld: false,
})
  .input(
    standard(
      Schema.Struct({
        id: Id.annotate({ description: 'The activity id (list_activities)' }),
        samples: opt(Schema.Literals(['none', 'minute'])),
      })
    )
  )
  .handler(async ({ input, context }) => {
    const activity = await context.run(Tools.use((tools) => tools.getActivity(input)))
    if (activity === null) throw new ORPCError('NOT_FOUND', { message: `No activity ${input.id}.` })
    return activity
  })

const compareRuns = tool({
  name: 'compare_runs',
  title: 'Compare runs',
  description:
    'Compare activities side by side (typically runs): pace, HR, cadence, climb, load, minutes per HR zone, efficiency (metres per minute per heartbeat: higher is fitter at the same effort), aerobic decoupling (%) and splits per km.',
  method: 'POST',
  path: '/activities/compare',
  tags: ['activities'],
  readOnly: true,
  openWorld: false,
})
  .input(
    standard(
      Schema.Struct({ ids: Schema.Array(Id).annotate({ description: 'Activity ids, 2 to 10' }) })
    )
  )
  .handler(({ input, context }) => {
    if (input.ids.length === 0 || input.ids.length > 10) {
      throw new ORPCError('BAD_REQUEST', { message: 'Compare 1 to 10 activities.' })
    }
    return context.run(Tools.use((tools) => tools.compareRuns(input.ids)))
  })

const dailyReadiness = tool({
  name: 'daily_readiness',
  title: 'Daily readiness',
  description:
    "Recovery for a morning go/no-go: per day (newest first) sleep (hours, score, bedtime, wake), overnight HRV and its weekly average, status and baseline band, resting HR, body battery, Garmin's training readiness, acute load and stress; the 28-day baseline before the window; the activities of the last 3 days; the workouts planned today and tomorrow.",
  method: 'GET',
  path: '/readiness',
  tags: ['wellness'],
  readOnly: true,
  openWorld: false,
})
  .input(
    standard(
      Schema.Struct({
        day: opt(Day.annotate({ description: 'YYYY-MM-DD, default today (Paris)' })),
        days: opt(Schema.Int.annotate({ description: 'Days in the window, default 7' })),
      })
    )
  )
  .handler(({ input, context }) => context.run(Tools.use((tools) => tools.dailyReadiness(input))))

const weeklyLoad = tool({
  name: 'weekly_load',
  title: 'Weekly load',
  description:
    "Training volume per ISO week (newest first): activities, km, hours, ascent, training load, longest activity, minutes in HR zones 1-2 / 3 / 4-5; with the acute (7 days) and chronic (weekly mean of 28 days) training load of every sport and their ratio, and Garmin's own acute load.",
  method: 'GET',
  path: '/weekly-load',
  tags: ['activities'],
  readOnly: true,
  openWorld: false,
})
  .input(
    standard(
      Schema.Struct({
        weeks: opt(Schema.Int.annotate({ description: 'Default 12' })),
        sport: opt(
          Schema.String.annotate({ description: 'Part of the sport key; every sport by default' })
        ),
      })
    )
  )
  .handler(({ input, context }) => context.run(Tools.use((tools) => tools.weeklyLoad(input))))

const plannedWorkouts = tool({
  name: 'planned_workouts',
  title: 'Planned workouts',
  description:
    "The Garmin calendar's scheduled workouts with their steps (durations, HR and pace targets), and the ids of the activities that ran them. Each has its calendar entry id (unschedule_workout's schedule_id) and its workout_id (schedule_workout, delete_workout).",
  method: 'GET',
  path: '/planned-workouts',
  tags: ['workouts'],
  readOnly: true,
  openWorld: false,
})
  .input(
    standard(
      Schema.Struct({
        from: opt(Day.annotate({ description: 'Default today' })),
        to: opt(Day.annotate({ description: 'Default from + 14 days' })),
      })
    )
  )
  .handler(({ input, context }) => context.run(Tools.use((tools) => tools.plannedWorkouts(input))))

const syncStatus = tool({
  name: 'sync_status',
  title: 'Sync status',
  description:
    "Whether the data is fresh: the Garmin session (logged in, as whom, until when its token runs before a refresh), the sync's last runs (when, files written, warnings, error; logged_out: Garmin refused the session, the user must log in again at /garmin on the web app), when it last succeeded, the latest activity, night and weigh-in stored, the files that could not be read. Check it when data looks missing or stale.",
  method: 'GET',
  path: '/sync-status',
  tags: ['sync'],
  readOnly: true,
  openWorld: false,
}).handler(({ context }) =>
  context.run(
    Effect.gen(function* () {
      const status = yield* Tools.use((tools) => tools.syncStatus)
      const session = yield* GarminLogin.use((login) => login.status)
      return { garmin_session: session, ...status }
    })
  )
)

const schema = tool({
  name: 'schema',
  title: 'Garmin data schema',
  description: `List the tables and views with their columns.\n\n${DATA_MODEL}`,
  method: 'GET',
  path: '/schema',
  tags: ['sql'],
  readOnly: true,
  openWorld: false,
}).handler(({ context }) =>
  context.run(
    Reader.use((reader) =>
      Effect.map(reader.columns, (columns) => {
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
    )
  )
)

const sql = tool({
  name: 'sql',
  title: 'Query Garmin data',
  description: `Run one read-only SQLite statement on the user's Garmin data and return the rows as JSON. Prefer the typed tools; use this for anything they do not answer.\n\n${DATA_MODEL}\n\n${QUERY_GUIDE}`,
  method: 'POST',
  path: '/sql',
  tags: ['sql'],
  readOnly: true,
  openWorld: false,
})
  .input(
    standard(
      Schema.Struct({
        query: Schema.String.annotate({ description: 'A single read-only SQL statement' }),
      })
    )
  )
  .handler(({ input, context }) =>
    context.run(
      Reader.use((reader) => Effect.map(reader.query(input.query), (result) => capRows(result)))
    )
  )

// --- The workouts on the watch: these change the user's real Garmin Connect account

const createWorkout = tool({
  name: 'create_workout',
  title: 'Create a workout on the watch',
  description: `Create a structured workout in the user's Garmin Connect library (runs with pace or heart-rate targets, warm-up, cool-down, repeat groups; strength circuits of exercises from Garmin's catalog, see find_exercises), and schedule it on the given dates. ${WATCH}
Conventions: name runs with their date and plan, one workout per date (e.g. "Plan - tue 03/11 - Easy 40' + 5 strides"), and schedule each on its date; a routine (the same strength circuit every morning) is one workout scheduled on many dates. At most one scheduled workout a day: with two, the watch stops offering the run. A workout with the same name already in the library is refused (delete it first, or schedule the existing one).
Steps: each ends after exactly one of duration ("3:00", "45'", 180 s), distance_m, reps (strength) or lap_button: true; one target at most: pace { slow, fast } ("6'10/km", or seconds per km) or hr { low, high } (bpm). Repeat groups: { repeat: 6, steps: [...] }.
dry_run: true checks everything and returns the exact requests and the steps as the watch will show them, sending nothing. Returns the workout id, its calendar entries (schedule ids) and planned_workouts read back after the write.`,
  method: 'POST',
  path: '/workouts',
  tags: ['workouts'],
  readOnly: false,
  openWorld: true,
})
  .input(
    standard(
      Schema.Struct({
        ...WorkoutSchema.fields,
        schedule: opt(
          Schema.Array(Day).annotate({
            description: 'Dates to schedule it on (YYYY-MM-DD); none: library only',
          })
        ),
        dry_run: opt(
          Schema.Boolean.annotate({ description: 'Return the requests without sending them' })
        ),
        allow_duplicate_name: opt(
          Schema.Boolean.annotate({
            description: 'Create it even if a workout has this name already',
          })
        ),
      })
    )
  )
  .handler(({ input: { schedule, dry_run, allow_duplicate_name, ...workout }, context }) =>
    context.run(
      GarminWorkouts.use((workouts) =>
        workouts.create(workout, { schedule, dry_run, allow_duplicate_name })
      )
    )
  )

const scheduleWorkout = tool({
  name: 'schedule_workout',
  title: 'Schedule a workout on the watch',
  description: `Schedule a workout of the library (its workout_id: list_workouts, planned_workouts) on one more date of the Garmin calendar. ${WATCH} dry_run: true returns the request without sending it. Returns the calendar entries of that day, read back.`,
  method: 'POST',
  path: '/workouts/{workout_id}/schedule',
  tags: ['workouts'],
  readOnly: false,
  openWorld: true,
})
  .input(standard(Schema.Struct({ workout_id: Id, date: Day, dry_run: opt(Schema.Boolean) })))
  .handler(({ input, context }) =>
    context.run(GarminWorkouts.use((workouts) => workouts.schedule(input)))
  )

const unscheduleWorkout = tool({
  name: 'unschedule_workout',
  title: 'Remove a workout from the calendar',
  description: `Remove one calendar entry from the Garmin calendar (the workout stays in the library). Name it exactly: its schedule_id (planned_workouts' id), its date and its workout's name, checked against Garmin's calendar before anything is removed. One entry per call, never by pattern. ${WATCH} dry_run: true returns the request without sending it.`,
  method: 'DELETE',
  path: '/calendar/{schedule_id}',
  tags: ['workouts'],
  readOnly: false,
  destructive: true,
  idempotent: true,
  openWorld: true,
})
  .input(
    standard(
      Schema.Struct({
        schedule_id: Id.annotate({ description: "The calendar entry's id (planned_workouts.id)" }),
        date: Day,
        name: Schema.String.annotate({ description: "The workout's exact name on that entry" }),
        dry_run: opt(Schema.Boolean),
      })
    )
  )
  .handler(({ input, context }) =>
    context.run(GarminWorkouts.use((workouts) => workouts.unschedule(input)))
  )

const deleteWorkout = tool({
  name: 'delete_workout',
  title: 'Delete a workout from the watch',
  description: `Delete one workout from the Garmin Connect library, with every calendar entry that schedules it. Name it exactly: its workout_id and its exact name, checked against Garmin before anything is deleted. One workout per call, never by pattern. ${WATCH} dry_run: true returns the request and the calendar entries that would go, without sending it.`,
  method: 'DELETE',
  path: '/workouts/{workout_id}',
  tags: ['workouts'],
  readOnly: false,
  destructive: true,
  idempotent: true,
  openWorld: true,
})
  .input(
    standard(
      Schema.Struct({
        workout_id: Id,
        name: Schema.String.annotate({ description: "The workout's exact name" }),
        dry_run: opt(Schema.Boolean),
      })
    )
  )
  .handler(({ input, context }) =>
    context.run(GarminWorkouts.use((workouts) => workouts.remove(input)))
  )

const listWorkouts = tool({
  name: 'list_workouts',
  title: 'List the workout library',
  description:
    "The workouts of the user's Garmin Connect library (scheduled or not), newest first: workout_id, name, sport, estimated minutes, created and updated. Read-only.",
  method: 'GET',
  path: '/workouts',
  tags: ['workouts'],
  readOnly: true,
  openWorld: true,
})
  .input(
    standard(
      Schema.Struct({
        name_contains: opt(Schema.String.annotate({ description: 'Case-insensitive' })),
        limit: opt(Schema.Int.annotate({ description: 'Default 100, at most 1000' })),
      })
    )
  )
  .handler(async ({ input, context }) => ({
    workouts: await context.run(GarminWorkouts.use((workouts) => workouts.library(input))),
  }))

const findExercisesTool = tool({
  name: 'find_exercises',
  title: 'Find strength exercises',
  description:
    "Search Garmin's catalog of strength exercises (1527, its workout editor's) for create_workout: every word must match the name or the keys, e.g. 'side plank', 'superman', 'calf raise'. Returns the name (create_workout's exercise) and the category and exercise_name keys, the closest first.",
  method: 'GET',
  path: '/exercises',
  tags: ['workouts'],
  readOnly: true,
  openWorld: false,
})
  .input(
    standard(
      Schema.Struct({
        query: Schema.String,
        limit: opt(Schema.Int.annotate({ description: 'Default 25, at most 200' })),
      })
    )
  )
  .handler(({ input }) => ({
    exercises: findExercises(input.query, Math.min(Math.max(input.limit ?? 25, 1), 200)).map(
      (entry) => ({ name: entry.name, category: entry.category, exercise_name: entry.exercise })
    ),
  }))

// The public API: the MCP's tools, /api's operations, /rpc's calls
export const garmin = {
  activities: { list: listActivities, get: getActivity, compare: compareRuns },
  readiness: dailyReadiness,
  weeklyLoad,
  plannedWorkouts,
  syncStatus,
  schema,
  sql,
  workouts: {
    create: createWorkout,
    schedule: scheduleWorkout,
    unschedule: unscheduleWorkout,
    delete: deleteWorkout,
    list: listWorkouts,
  },
  exercises: { find: findExercisesTool },
}
