import { asc, eq } from 'drizzle-orm'
import { Context, Effect, Layer, Option, Schema } from 'effect'

import { Database, type DatabaseError } from '../db.ts'
import { plannedWorkouts } from '../schema.ts'

import { type ApiFailure, GarminApi, type WriteMethod } from './api.ts'
import { GarminSync } from './sync.ts'
import { buildWorkout, type WorkoutInput } from './workout-builder.ts'

// The workouts on the user's watch: Garmin Connect's workout library and its calendar, written
// through the app's own session (create, schedule, unschedule, delete). Each write is checked
// first (a delete names the exact workout or calendar entry, read back from Garmin), can be a dry
// run (the exact requests, nothing sent), and is followed by a refresh of the calendar months it
// touched: planned_workouts then reads back what the watch will get.

export class WorkoutError extends Schema.TaggedError<WorkoutError>()('WorkoutError', {
  message: Schema.String,
}) {}

// A request a write sends (or would, in a dry run)
export interface WriteRequest {
  readonly method: WriteMethod
  readonly path: string
  readonly body?: unknown
}

// A calendar entry as planned_workouts holds it: `id` is what unschedule_workout takes
export interface CalendarEntry {
  readonly id: number
  readonly day: string
  readonly workout_id: number | null
  readonly name: string
  readonly steps: string | null
}

export interface LibraryWorkout {
  readonly workout_id: number
  readonly name: string
  readonly sport: string | null
  readonly estimated_minutes: number | null
  readonly created: string | null
  readonly updated: string | null
}

const WORKOUT = '/workout-service/workout'
const SCHEDULE = '/workout-service/schedule'
const LIBRARY_PAGE = 100
const LIBRARY_MAX = 1000
const MAX_DATES = 120

const Id = Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0))
const Created = Schema.Struct({ workoutId: Id })
const Scheduled = Schema.Struct({
  workoutScheduleId: Schema.optional(Schema.NullOr(Schema.Number)),
})
const Workout = Schema.Struct({
  workoutId: Id,
  workoutName: Schema.String,
  sportType: Schema.optional(Schema.NullOr(Schema.Struct({ sportTypeKey: Schema.String }))),
  estimatedDurationInSecs: Schema.optional(Schema.NullOr(Schema.Number)),
  createdDate: Schema.optional(Schema.NullOr(Schema.String)),
  updateDate: Schema.optional(Schema.NullOr(Schema.String)),
})
const CalendarItem = Schema.Struct({
  id: Schema.Number,
  itemType: Schema.optional(Schema.NullOr(Schema.String)),
  title: Schema.optional(Schema.NullOr(Schema.String)),
  date: Schema.String,
  workoutId: Schema.optional(Schema.NullOr(Schema.Number)),
})
const Calendar = Schema.Struct({ calendarItems: Schema.Array(Schema.Unknown) })
const decode =
  <S extends Schema.Decoder<unknown>>(schema: S) =>
  (value: unknown) =>
    Option.getOrUndefined(Schema.decodeUnknownOption(schema)(value))

// A real day, YYYY-MM-DD
export const isDay = (value: string) =>
  /^\d{4}-\d{2}-\d{2}$/u.test(value) &&
  new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value

const failed = (error: ApiFailure | DatabaseError) =>
  new WorkoutError({
    message: error._tag === 'DatabaseError' ? 'the database failed' : error.message,
  })

export class GarminWorkouts extends Context.Service<
  GarminWorkouts,
  {
    // A new workout, scheduled on `schedule`'s days (none: only in the library)
    readonly create: (
      input: WorkoutInput,
      options: {
        readonly schedule?: ReadonlyArray<string> | undefined
        readonly dry_run?: boolean | undefined
        readonly allow_duplicate_name?: boolean | undefined
      }
    ) => Effect.Effect<unknown, WorkoutError>
    // A workout of the library on one more day
    readonly schedule: (options: {
      readonly workout_id: number
      readonly date: string
      readonly dry_run?: boolean | undefined
    }) => Effect.Effect<unknown, WorkoutError>
    // One calendar entry removed (the workout stays in the library): its id, day and name must match
    readonly unschedule: (options: {
      readonly schedule_id: number
      readonly date: string
      readonly name: string
      readonly dry_run?: boolean | undefined
    }) => Effect.Effect<unknown, WorkoutError>
    // One workout deleted from the library, its calendar entries with it: its id and name must match
    readonly remove: (options: {
      readonly workout_id: number
      readonly name: string
      readonly dry_run?: boolean | undefined
    }) => Effect.Effect<unknown, WorkoutError>
    // The library, newest first
    readonly library: (options: {
      readonly name_contains?: string | undefined
      readonly limit?: number | undefined
    }) => Effect.Effect<ReadonlyArray<LibraryWorkout>, WorkoutError>
  }
>()('garmin/GarminWorkouts') {
  static readonly layer = Layer.effect(
    GarminWorkouts,
    Effect.gen(function* () {
      const api = yield* GarminApi
      const sync = yield* GarminSync
      const { use } = yield* Database

      const send = ({ method, path, body }: WriteRequest) =>
        api.write(method, path, body).pipe(Effect.mapError(failed))

      // The calendar entries of a workout, as planned_workouts holds them
      const entriesOf = (workoutId: number) =>
        use((db) =>
          db
            .select({
              id: plannedWorkouts.id,
              day: plannedWorkouts.day,
              workout_id: plannedWorkouts.workout_id,
              name: plannedWorkouts.name,
              steps: plannedWorkouts.steps,
            })
            .from(plannedWorkouts)
            .where(eq(plannedWorkouts.workout_id, workoutId))
            .orderBy(asc(plannedWorkouts.day))
            .all()
        ).pipe(Effect.mapError(failed))

      const entriesOn = (day: string) =>
        use((db) =>
          db
            .select({
              id: plannedWorkouts.id,
              day: plannedWorkouts.day,
              workout_id: plannedWorkouts.workout_id,
              name: plannedWorkouts.name,
              steps: plannedWorkouts.steps,
            })
            .from(plannedWorkouts)
            .where(eq(plannedWorkouts.day, day))
            .all()
        ).pipe(Effect.mapError(failed))

      // The calendar months of these days fetched again, into planned_workouts
      const refresh = (days: ReadonlyArray<string>) =>
        days.length === 0
          ? Effect.void
          : sync.refreshCalendar(days.map((day) => day.slice(0, 7))).pipe(Effect.mapError(failed))

      const workoutById = (id: number) =>
        api.json(`${WORKOUT}/${id}`).pipe(
          Effect.mapError((error) =>
            error._tag === 'GarminError' && (error.status === 404 || error.status === 403)
              ? new WorkoutError({ message: `No workout ${id} in the library.` })
              : failed(error)
          ),
          Effect.flatMap((json) => {
            const workout = decode(Workout)(json)
            return workout === undefined
              ? Effect.fail(new WorkoutError({ message: `No workout ${id} in the library.` }))
              : Effect.succeed(workout)
          })
        )

      const library = Effect.fn('GarminWorkouts.library')(function* (options: {
        readonly name_contains?: string | undefined
        readonly limit?: number | undefined
      }) {
        const all: Array<LibraryWorkout> = []
        for (let start = 0; start < LIBRARY_MAX; start += LIBRARY_PAGE) {
          const page = yield* api
            .json('/workout-service/workouts', { start, limit: LIBRARY_PAGE })
            .pipe(Effect.mapError(failed))
          const items = Array.isArray(page) ? page : []
          for (const item of items) {
            const workout = decode(Workout)(item)
            if (workout === undefined) continue
            all.push({
              workout_id: workout.workoutId,
              name: workout.workoutName,
              sport: workout.sportType?.sportTypeKey ?? null,
              estimated_minutes:
                typeof workout.estimatedDurationInSecs === 'number'
                  ? Math.round(workout.estimatedDurationInSecs / 60)
                  : null,
              created: workout.createdDate ?? null,
              updated: workout.updateDate ?? null,
            })
          }
          if (items.length < LIBRARY_PAGE) break
        }
        const needle = options.name_contains?.toLowerCase()
        const limit = Math.min(Math.max(Math.trunc(options.limit ?? 100), 1), LIBRARY_MAX)
        return all
          .filter((workout) => needle === undefined || workout.name.toLowerCase().includes(needle))
          .slice(0, limit)
      })

      const checkDays = (days: ReadonlyArray<string>) => {
        const bad = days.filter((day) => !isDay(day))
        if (bad.length > 0) {
          return Effect.fail(
            new WorkoutError({ message: `Not dates (YYYY-MM-DD): ${bad.join(', ')}` })
          )
        }
        if (days.length > MAX_DATES) {
          return Effect.fail(new WorkoutError({ message: `${MAX_DATES} dates at most per call.` }))
        }
        return Effect.succeed([...new Set(days)].toSorted())
      }

      const create = Effect.fn('GarminWorkouts.create')(function* (
        input: WorkoutInput,
        options: {
          readonly schedule?: ReadonlyArray<string> | undefined
          readonly dry_run?: boolean | undefined
          readonly allow_duplicate_name?: boolean | undefined
        }
      ) {
        const built = buildWorkout(input)
        if (!built.ok) {
          return yield* new WorkoutError({
            message: `The workout is invalid:\n${built.errors.join('\n')}`,
          })
        }
        const days = yield* checkDays(options.schedule ?? [])
        const name = built.payload.workoutName
        if (options.allow_duplicate_name !== true) {
          const same = (yield* library({})).filter((workout) => workout.name === name)
          if (same.length > 0) {
            return yield* new WorkoutError({
              message: `A workout named "${name}" is already in the library (${same.map((workout) => workout.workout_id).join(', ')}): schedule it, delete it first, or pass allow_duplicate_name.`,
            })
          }
        }
        const upload: WriteRequest = { method: 'POST', path: WORKOUT, body: built.payload }
        if (options.dry_run === true) {
          return {
            dry_run: true,
            name,
            steps: built.steps,
            requests: [
              upload,
              ...days.map((date): WriteRequest => ({
                method: 'POST',
                path: `${SCHEDULE}/<workoutId>`,
                body: { date },
              })),
            ],
          }
        }
        const created = decode(Created)(yield* send(upload))
        if (created === undefined) {
          return yield* new WorkoutError({
            message: 'Garmin answered the upload without a workoutId.',
          })
        }
        const id = created.workoutId
        const scheduled: Array<{ date: string; schedule_id: number | null }> = []
        for (const date of days) {
          const answer = yield* send({
            method: 'POST',
            path: `${SCHEDULE}/${id}`,
            body: { date },
          }).pipe(
            Effect.mapError(
              (error) =>
                new WorkoutError({
                  message: `Workout ${id} "${name}" was created${scheduled.length > 0 ? ` and scheduled on ${scheduled.map((entry) => entry.date).join(', ')}` : ''}, but scheduling it on ${date} failed: ${error.message}`,
                })
            )
          )
          scheduled.push({
            date,
            schedule_id: decode(Scheduled)(answer)?.workoutScheduleId ?? null,
          })
        }
        yield* refresh(days)
        return {
          workout_id: id,
          name,
          steps: built.steps,
          scheduled,
          planned: yield* entriesOf(id),
        }
      })

      const schedule = Effect.fn('GarminWorkouts.schedule')(function* (options: {
        readonly workout_id: number
        readonly date: string
        readonly dry_run?: boolean | undefined
      }) {
        const [date = ''] = yield* checkDays([options.date])
        const workout = yield* workoutById(options.workout_id)
        const request: WriteRequest = {
          method: 'POST',
          path: `${SCHEDULE}/${workout.workoutId}`,
          body: { date },
        }
        if (options.dry_run === true) {
          return {
            dry_run: true,
            workout_id: workout.workoutId,
            name: workout.workoutName,
            requests: [request],
          }
        }
        const answer = yield* send(request)
        yield* refresh([date])
        return {
          workout_id: workout.workoutId,
          name: workout.workoutName,
          date,
          schedule_id: decode(Scheduled)(answer)?.workoutScheduleId ?? null,
          planned_that_day: yield* entriesOn(date),
        }
      })

      const unschedule = Effect.fn('GarminWorkouts.unschedule')(function* (options: {
        readonly schedule_id: number
        readonly date: string
        readonly name: string
        readonly dry_run?: boolean | undefined
      }) {
        const [date = ''] = yield* checkDays([options.date])
        // The entry as Garmin's calendar has it now
        const calendar = decode(Calendar)(
          yield* api
            .json(
              `/calendar-service/year/${date.slice(0, 4)}/month/${Number(date.slice(5, 7)) - 1}`
            )
            .pipe(Effect.mapError(failed))
        )
        const items = (calendar?.calendarItems ?? []).flatMap((raw) => {
          const item = decode(CalendarItem)(raw)
          return item === undefined || item.itemType !== 'workout' ? [] : [item]
        })
        const that = items.filter((item) => item.date.slice(0, 10) === date)
        const listed = that.map((item) => `${item.id} "${item.title ?? ''}"`).join(', ') || 'none'
        const entry = that.find((item) => item.id === options.schedule_id)
        if (entry === undefined) {
          return yield* new WorkoutError({
            message: `No calendar entry ${options.schedule_id} on ${date}. The workouts that day: ${listed}.`,
          })
        }
        if ((entry.title ?? '') !== options.name) {
          return yield* new WorkoutError({
            message: `Calendar entry ${entry.id} on ${date} is "${entry.title ?? ''}", not "${options.name}": nothing removed.`,
          })
        }
        const request: WriteRequest = { method: 'DELETE', path: `${SCHEDULE}/${entry.id}` }
        const removed = {
          schedule_id: entry.id,
          date,
          name: entry.title ?? '',
          workout_id: entry.workoutId ?? null,
        }
        if (options.dry_run === true)
          return { dry_run: true, unschedule: removed, requests: [request] }
        yield* send(request)
        yield* refresh([date])
        return { unscheduled: removed, planned_that_day: yield* entriesOn(date) }
      })

      const remove = Effect.fn('GarminWorkouts.remove')(function* (options: {
        readonly workout_id: number
        readonly name: string
        readonly dry_run?: boolean | undefined
      }) {
        const workout = yield* workoutById(options.workout_id)
        if (workout.workoutName !== options.name) {
          return yield* new WorkoutError({
            message: `Workout ${workout.workoutId} is "${workout.workoutName}", not "${options.name}": nothing deleted.`,
          })
        }
        // Its calendar entries go with it (the synced months: planned_workouts)
        const entries = yield* entriesOf(workout.workoutId)
        const request: WriteRequest = { method: 'DELETE', path: `${WORKOUT}/${workout.workoutId}` }
        const deleted = { workout_id: workout.workoutId, name: workout.workoutName }
        if (options.dry_run === true) {
          return {
            dry_run: true,
            delete: deleted,
            calendar_entries_going_with_it: entries,
            requests: [request],
          }
        }
        yield* send(request)
        yield* refresh(entries.map((entry) => entry.day))
        return {
          deleted,
          calendar_entries_removed: entries,
          still_planned: yield* entriesOf(workout.workoutId),
        }
      })

      return GarminWorkouts.of({ create, schedule, unschedule, remove, library })
    })
  )
}
