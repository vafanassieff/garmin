import { statSync } from 'node:fs'

import * as NodeServices from '@effect/platform-node/NodeServices'
import { expect, layer } from '@effect/vitest'
import { Effect, Layer, Option } from 'effect'
import yazl from 'yazl'

import { apiSummary, dailyFile, fitRun, rows, sql, testConfig } from '../../test/fixtures.ts'
import { fakeGarmin, inHours, json, jwt, type FakeRequest } from '../../test/garmin.ts'
import { Database } from '../db.ts'
import { Ingest } from '../ingest.ts'
import { parisToday } from '../tools.ts'

import { GarminApi } from './api.ts'
import { GarminSession } from './session.ts'
import { addDays, fitOfZip, monthEnd, months, GarminSync } from './sync.ts'

const zipOf = (name: string, bytes: Uint8Array) =>
  new Promise<Uint8Array>((resolve, reject) => {
    const zip = new yazl.ZipFile()
    zip.addBuffer(Buffer.from(bytes), name)
    zip.end()
    const parts: Array<Buffer> = []
    zip.outputStream.on('data', (part: Buffer) => parts.push(part))
    zip.outputStream.on('end', () => resolve(new Uint8Array(Buffer.concat(parts))))
    zip.outputStream.on('error', reject)
  })

const first = jwt({ exp: inHours(20), client_id: 'client' })
const second = jwt({ exp: inHours(24), client_id: 'client' })

// Garmin Connect for one day `today`: one run, its FIT file, the day's wellness, a workout planned.
// The first API call is refused once (401): the token is refreshed, then the call made again.
const connect = (today: string, fit: Uint8Array, refuse: 'once' | 'always') => {
  let refused = false
  return async ({ url, headers, body }: FakeRequest): Promise<Response> => {
    const path = url.pathname
    if (url.host === 'diauth.garmin.com') {
      expect(new URLSearchParams(body).get('refresh_token')).toBe('refresh-1')
      return refuse === 'always'
        ? json({ error: 'invalid_grant' }, { status: 400 })
        : json({ access_token: second, refresh_token: 'refresh-2' })
    }
    if (!refused || refuse === 'always') {
      refused = true
      expect(headers['authorization']).toBe(`Bearer ${first}`)
      return json({ message: 'Token is not active' }, { status: 401 })
    }
    expect(headers['authorization']).toBe(`Bearer ${second}`)
    const day = dailyFile(today)
    if (path === '/userprofile-service/socialProfile') {
      return json({ displayName: 'runner-1', fullName: 'Test Runner' })
    }
    if (path === '/activitylist-service/activities/search/activities') {
      return json(
        url.searchParams.get('start') === '0'
          ? [
              apiSummary(42, {
                startTimeLocal: `${today} 07:12:40`,
                startTimeGMT: `${today} 06:12:40`,
                gear: undefined,
              }),
            ]
          : []
      )
    }
    if (path === '/download-service/files/activity/42') {
      return new Response(Buffer.from(await zipOf('42_ACTIVITY.fit', fit)))
    }
    if (path === '/gear-service/gear/filterGear') return json([{ displayName: 'Road Shoes' }])
    if (path === '/usersummary-service/usersummary/daily/runner-1') return json(day.stats)
    if (path === '/wellness-service/wellness/dailySleepData/runner-1') return json(day.sleep)
    if (path === `/hrv-service/hrv/${today}`) return json(day.hrv)
    if (path === `/metrics-service/metrics/trainingreadiness/${today}`) {
      return json(day.training_readiness)
    }
    if (
      path.startsWith('/hrv-service/') ||
      path.startsWith('/metrics-service/metrics/trainingreadiness/')
    ) {
      return new Response(null, { status: 204 })
    }
    if (path.startsWith('/metrics-service/')) return json([])
    if (path === '/weight-service/weight/dateRange') {
      return json({
        startDate: url.searchParams.get('startDate'),
        endDate: url.searchParams.get('endDate'),
        dateWeightList: [],
      })
    }
    if (path.startsWith('/calendar-service/')) {
      return json({
        calendarItems: [
          { id: 1, itemType: 'workout', workoutId: 7, date: addDays(today, 1), title: 'Steady 30' },
          { id: 2, itemType: 'workout', workoutId: 7, date: addDays(today, 2), title: 'Steady 30' },
        ],
      })
    }
    if (path === '/workout-service/workout/7')
      return json({ workoutName: 'Steady 30', workoutSegments: [] })
    if (path.startsWith('/usersummary-service/') || path.startsWith('/wellness-service/')) {
      return json(null)
    }
    return new Response(`unexpected ${path}`, { status: 500 })
  }
}

const garminLayer = (handle: (request: FakeRequest) => Promise<Response>) => {
  const garmin = fakeGarmin(handle)
  return {
    log: garmin.log,
    layer: GarminSync.layer.pipe(
      Layer.provideMerge(GarminApi.layer),
      Layer.provideMerge(GarminSession.layer),
      Layer.provideMerge(Ingest.layer),
      Layer.provideMerge(Database.layer),
      Layer.provideMerge(Layer.merge(NodeServices.layer, garmin.layer)),
      Layer.provide(testConfig)
    ),
  }
}

const saveSession = GarminSession.use((session) =>
  session.save(
    { di_token: first, di_refresh_token: 'refresh-1', di_client_id: 'client' },
    { display_name: 'runner-1', full_name: 'Test Runner' }
  )
)

let today = ''
let fit: Uint8Array = new Uint8Array()
const prepare = Effect.gen(function* () {
  today = yield* parisToday
  fit = fitRun({ start: new Date(`${today}T06:12:40Z`) })
})

// One handler per layer, made at its first request (once today is known)
const lazily = (refuse: 'once' | 'always') => {
  let handle: ((request: FakeRequest) => Promise<Response>) | undefined
  return (request: FakeRequest) => {
    handle ??= connect(today, fit, refuse)
    return handle(request)
  }
}

const ok = garminLayer(lazily('once'))

// The real clock: the sync's days are today's
layer(ok.layer, { excludeTestServices: true })('GarminSync', (it) => {
  it.effect('syncs Garmin Connect into data/ and SQLite, refreshing a refused token', () =>
    Effect.gen(function* () {
      yield* prepare
      const sync = yield* GarminSync
      expect((yield* sync.run()).error).toBe('no Garmin session: log in first')
      yield* saveSession
      const outcome = yield* sync.run({ since: today })
      expect(outcome).toMatchObject({
        ok: true,
        logged_out: false,
        account: 'Test Runner',
        since: today,
        warnings: [],
      })
      // FIT, summary, the day, a body month, the calendar's months, the workout once
      const calendarMonths = months(
        `${addDays(`${today.slice(0, 7)}-01`, -1).slice(0, 7)}-01`,
        addDays(`${today.slice(0, 7)}-01`, 62)
      ).length
      expect(outcome.files_written).toBe(5 + calendarMonths)

      const [activity] = yield* rows(sql`SELECT id, day, sport, gear, distance_m FROM activities`)
      expect(activity).toMatchObject({ id: 42, day: today, sport: 'running', gear: 'Road Shoes' })
      expect((yield* rows(sql`SELECT count(*) AS n FROM samples`))[0]).toEqual({ n: 1201 })
      const [night] = yield* rows(sql`SELECT day, hrv, sleep_s, readiness FROM daily`)
      expect(night).toEqual({ day: today, hrv: 52, sleep_s: 26_400, readiness: 88 })
      expect(yield* rows(sql`SELECT day, name FROM planned_workouts ORDER BY day`)).toEqual([
        { day: addDays(today, 1), name: 'Steady 30' },
        { day: addDays(today, 2), name: 'Steady 30' },
      ])
      expect(yield* rows(sql`SELECT ok, logged_out, account FROM sync_runs`)).toEqual([
        { ok: 1, logged_out: 0, account: 'Test Runner' },
      ])
      expect(
        ok.log.filter((request) => request.url.pathname === '/workout-service/workout/7')
      ).toHaveLength(1)

      // The refreshed session, saved 0600
      const session = yield* GarminSession
      const saved = Option.getOrThrow(yield* session.load)
      expect(saved).toMatchObject({ di_token: second, di_refresh_token: 'refresh-2' })
      expect(statSync(session.path).mode & 0o777).toBe(0o600)

      // Again: the FIT file is not downloaded twice
      yield* sync.run({ since: today })
      expect(
        ok.log.filter((request) => request.url.pathname.startsWith('/download-service/'))
      ).toHaveLength(1)
    })
  )
})

const refused = garminLayer(lazily('always'))

layer(refused.layer, { excludeTestServices: true })('GarminSync, logged out', (it) => {
  it.effect('says so when Garmin refuses the session', () =>
    Effect.gen(function* () {
      yield* prepare
      yield* saveSession
      const outcome = yield* GarminSync.use((sync) => sync.run())
      expect(outcome.ok).toBe(false)
      expect(outcome.logged_out).toBe(true)
      expect(outcome.error).toContain('log in again')
      expect(yield* rows(sql`SELECT ok, logged_out FROM sync_runs`)).toEqual([
        { ok: 0, logged_out: 1 },
      ])
    })
  )
})

layer(NodeServices.layer)('sync helpers', (it) => {
  it('steps through months', () => {
    expect(months('2026-11-15', '2027-01-02')).toEqual(['2026-11-01', '2026-12-01', '2027-01-01'])
    expect(monthEnd('2028-02-01')).toBe('2028-02-29')
  })

  it.effect('takes the FIT file out of a download', () =>
    Effect.gen(function* () {
      const zip = yield* Effect.promise(() => zipOf('1_ACTIVITY.fit', new Uint8Array([1, 2, 3])))
      expect(yield* fitOfZip(zip)).toEqual(new Uint8Array([1, 2, 3]))
      const other = yield* Effect.promise(() => zipOf('1.gpx', new Uint8Array([1])))
      expect(yield* fitOfZip(other)).toBeNull()
    })
  )
})
