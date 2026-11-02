import * as NodeServices from '@effect/platform-node/NodeServices'
import { expect, layer } from '@effect/vitest'
import { Effect, Layer } from 'effect'

import { rows, sql, testConfig } from '../../test/fixtures.ts'
import { fakeGarmin, inHours, json, jwt, type FakeRequest } from '../../test/garmin.ts'
import { Database } from '../db.ts'
import { Ingest } from '../ingest.ts'

import { GarminApi } from './api.ts'
import { GarminSession } from './session.ts'
import { GarminSync } from './sync.ts'
import type { WorkoutInput } from './workout-builder.ts'
import { GarminWorkouts } from './workouts.ts'

// A fake Garmin Connect in memory: the workout library and its calendar (months from 0, as Garmin)
interface Entry {
  readonly id: number
  readonly workoutId: number
  readonly title: string
  readonly date: string
}
const library = new Map<number, Record<string, unknown>>()
let calendar: Array<Entry> = []
let nextId = 9000

const handle = ({ method, url, body }: FakeRequest): Response => {
  const path = url.pathname
  const workout = /^\/workout-service\/workout\/(\d+)$/u.exec(path)
  const schedule = /^\/workout-service\/schedule\/(\d+)$/u.exec(path)
  const month = /^\/calendar-service\/year\/(\d{4})\/month\/(\d{1,2})$/u.exec(path)
  if (method === 'GET' && path === '/workout-service/workouts') {
    const start = Number(url.searchParams.get('start'))
    return json([...library.values()].toReversed().slice(start, start + 100))
  }
  if (method === 'POST' && path === '/workout-service/workout') {
    nextId += 1
    const created = { ...(JSON.parse(body) as Record<string, unknown>), workoutId: nextId }
    library.set(nextId, created)
    return json(created)
  }
  if (workout !== null) {
    const id = Number(workout[1])
    if (!library.has(id)) return json({ message: 'not found' }, { status: 404 })
    if (method === 'GET') return json(library.get(id))
    if (method === 'DELETE') {
      library.delete(id)
      calendar = calendar.filter((entry) => entry.workoutId !== id)
      return new Response(null, { status: 204 })
    }
  }
  if (schedule !== null && method === 'POST') {
    const id = Number(schedule[1])
    const date = (JSON.parse(body) as { date: string }).date
    nextId += 1
    calendar.push({
      id: nextId,
      workoutId: id,
      title: String(library.get(id)?.['workoutName']),
      date,
    })
    return json({ workoutScheduleId: nextId, calendarDate: date })
  }
  if (schedule !== null && method === 'DELETE') {
    calendar = calendar.filter((entry) => entry.id !== Number(schedule[1]))
    return new Response(null, { status: 204 })
  }
  if (month !== null && method === 'GET') {
    const prefix = `${month[1]}-${String(Number(month[2]) + 1).padStart(2, '0')}`
    return json({
      calendarItems: calendar
        .filter((entry) => entry.date.startsWith(prefix))
        .map((entry) => ({ ...entry, itemType: 'workout', sportTypeKey: 'running' })),
    })
  }
  return new Response(`unexpected ${method} ${path}`, { status: 500 })
}

const garmin = fakeGarmin(handle)
const writes = () => garmin.log.filter((request) => request.method !== 'GET')

const testLayer = GarminWorkouts.layer.pipe(
  Layer.provideMerge(GarminSync.layer),
  Layer.provideMerge(GarminApi.layer),
  Layer.provideMerge(GarminSession.layer),
  Layer.provideMerge(Ingest.layer),
  Layer.provideMerge(Database.layer),
  Layer.provideMerge(Layer.merge(NodeServices.layer, garmin.layer)),
  Layer.provide(testConfig)
)

const loggedIn = GarminSession.use((session) =>
  session.save(
    {
      di_token: jwt({ exp: inHours(20), client_id: 'client' }),
      di_refresh_token: 'r',
      di_client_id: 'client',
    },
    { display_name: 'runner-1', full_name: 'Test Runner' }
  )
)

const EASY: WorkoutInput = {
  name: "Test - wed 13/01 - Easy 30'",
  sport: 'running',
  description: 'Easy run.',
  steps: [
    { kind: 'warmup', duration: "5'", hr: { low: 110, high: 140 } },
    { duration: '25:00', pace: { slow: "6'40/km", fast: "6'10/km" }, note: 'Easy' },
  ],
}

const planned = () =>
  rows<{ id: number; day: string; name: string; workout_id: number; steps: string }>(
    sql`SELECT id, day, name, workout_id, steps FROM planned_workouts ORDER BY day`
  )

const failure = <A, E extends { readonly message: string }>(effect: Effect.Effect<A, E>) =>
  Effect.map(Effect.flip(effect), (error) => error.message)

layer(testLayer, { excludeTestServices: true })('GarminWorkouts', (it) => {
  it.effect('builds and checks a workout in a dry run, sending nothing', () =>
    Effect.gen(function* () {
      yield* loggedIn
      const workouts = yield* GarminWorkouts
      const dry = (yield* workouts.create(EASY, {
        schedule: ['2027-01-13'],
        dry_run: true,
      })) as {
        requests: Array<{ method: string; path: string; body: unknown }>
        steps: Array<string>
      }
      expect(dry.requests.map((request) => `${request.method} ${request.path}`)).toEqual([
        'POST /workout-service/workout',
        'POST /workout-service/schedule/<workoutId>',
      ])
      expect(dry.requests[0]?.body).toMatchObject({
        workoutName: "Test - wed 13/01 - Easy 30'",
        estimatedDurationInSecs: 1800,
      })
      expect(dry.steps).toEqual([
        'warmup 5:00 HR 110-140',
        'interval 25:00 pace 6:10/km-6:40/km (Easy)',
      ])
      expect(writes()).toEqual([])
      // An invalid one says why, each problem by its step
      expect(
        yield* failure(
          workouts.create({ ...EASY, steps: [{ duration: '5 parsecs' }] }, { dry_run: true })
        )
      ).toBe('The workout is invalid:\nsteps[0]: duration "5 parsecs" unreadable')
      expect(
        yield* failure(workouts.create(EASY, { schedule: ['2027-02-30'], dry_run: true }))
      ).toBe('Not dates (YYYY-MM-DD): 2027-02-30')
    })
  )

  it.effect('creates it, schedules it on each date, and reads the calendar back', () =>
    Effect.gen(function* () {
      const workouts = yield* GarminWorkouts
      const created = (yield* workouts.create(EASY, {
        schedule: ['2027-02-03', '2027-01-13'],
      })) as {
        workout_id: number
        scheduled: Array<{ date: string; schedule_id: number }>
        planned: Array<{ id: number; day: string; name: string; steps: string }>
      }
      // The upload, then each date in order: Garmin's payload as built
      expect(writes().map((request) => `${request.method} ${request.url.pathname}`)).toEqual([
        'POST /workout-service/workout',
        `POST /workout-service/schedule/${created.workout_id}`,
        `POST /workout-service/schedule/${created.workout_id}`,
      ])
      expect(JSON.parse(writes()[1]?.body ?? '')).toEqual({ date: '2027-01-13' })
      expect(created.scheduled.map((entry) => entry.date)).toEqual(['2027-01-13', '2027-02-03'])
      // The touched months fetched again (January is month 0), into planned_workouts
      expect(
        garmin.log
          .filter((request) => request.url.pathname.startsWith('/calendar-service/'))
          .map((request) => request.url.pathname)
      ).toEqual(['/calendar-service/year/2027/month/0', '/calendar-service/year/2027/month/1'])
      expect(created.planned).toEqual(
        created.scheduled.map((entry) => ({
          id: entry.schedule_id,
          day: entry.date,
          workout_id: created.workout_id,
          name: EASY.name,
          steps: 'warmup 5:00 HR 110-140\ninterval 25:00 pace 6:10/km-6:40/km (Easy)',
        }))
      )
      expect(yield* planned()).toHaveLength(2)
      // The same name again: refused, nothing sent
      const before = writes().length
      expect(yield* failure(workouts.create(EASY, { schedule: ['2027-01-20'] }))).toMatch(
        /already in the library/u
      )
      expect(writes()).toHaveLength(before)
    })
  )

  it.effect('schedules a library workout on one more date', () =>
    Effect.gen(function* () {
      const workouts = yield* GarminWorkouts
      const [workout] = yield* workouts.library({ name_contains: 'easy 30' })
      expect(workout).toMatchObject({ name: EASY.name, sport: 'running', estimated_minutes: 30 })
      const answer = (yield* workouts.schedule({
        workout_id: workout?.workout_id ?? 0,
        date: '2027-01-20',
      })) as { planned_that_day: Array<{ name: string }> }
      expect(answer.planned_that_day.map((entry) => entry.name)).toEqual([EASY.name])
      expect(yield* planned()).toHaveLength(3)
      expect(yield* failure(workouts.schedule({ workout_id: 1, date: '2027-01-20' }))).toBe(
        'No workout 1 in the library.'
      )
    })
  )

  it.effect('unschedules one entry, named exactly', () =>
    Effect.gen(function* () {
      const workouts = yield* GarminWorkouts
      const [entry] = yield* planned()
      const id = entry?.id ?? 0
      const before = writes().length
      expect(
        yield* failure(
          workouts.unschedule({ schedule_id: id, date: '2027-01-13', name: 'Test - other' })
        )
      ).toBe(
        `Calendar entry ${id} on 2027-01-13 is "${EASY.name}", not "Test - other": nothing removed.`
      )
      expect(
        yield* failure(workouts.unschedule({ schedule_id: 1, date: '2027-01-13', name: EASY.name }))
      ).toBe(`No calendar entry 1 on 2027-01-13. The workouts that day: ${id} "${EASY.name}".`)
      expect(
        yield* failure(
          workouts.unschedule({ schedule_id: id, date: '2027-01-20', name: EASY.name })
        )
      ).toMatch(/^No calendar entry/u)
      // A dry run sends nothing either
      yield* workouts.unschedule({
        schedule_id: id,
        date: '2027-01-13',
        name: EASY.name,
        dry_run: true,
      })
      expect(writes()).toHaveLength(before)

      yield* workouts.unschedule({ schedule_id: id, date: '2027-01-13', name: EASY.name })
      expect(writes().at(-1)).toMatchObject({ method: 'DELETE' })
      expect(writes().at(-1)?.url.pathname).toBe(`/workout-service/schedule/${id}`)
      expect((yield* planned()).map((row) => row.day)).toEqual(['2027-01-20', '2027-02-03'])
    })
  )

  it.effect('deletes one workout, named exactly, with its calendar entries', () =>
    Effect.gen(function* () {
      const workouts = yield* GarminWorkouts
      const [workout] = yield* workouts.library({})
      const id = workout?.workout_id ?? 0
      const before = writes().length
      expect(yield* failure(workouts.remove({ workout_id: id, name: 'Test' }))).toBe(
        `Workout ${id} is "${EASY.name}", not "Test": nothing deleted.`
      )
      const dry = (yield* workouts.remove({ workout_id: id, name: EASY.name, dry_run: true })) as {
        calendar_entries_going_with_it: Array<unknown>
      }
      expect(dry.calendar_entries_going_with_it).toHaveLength(2)
      expect(writes()).toHaveLength(before)

      const done = (yield* workouts.remove({ workout_id: id, name: EASY.name })) as {
        calendar_entries_removed: Array<unknown>
        still_planned: Array<unknown>
      }
      expect(writes().at(-1)?.url.pathname).toBe(`/workout-service/workout/${id}`)
      expect(done.calendar_entries_removed).toHaveLength(2)
      expect(done.still_planned).toEqual([])
      expect(yield* planned()).toEqual([])
      expect(yield* workouts.library({})).toEqual([])
    })
  )
})
