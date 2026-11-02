import { join } from 'node:path'

import { desc, eq } from 'drizzle-orm'
import {
  Cause,
  Clock,
  Config,
  Context,
  Effect,
  FileSystem,
  Layer,
  Option,
  Queue,
  Ref,
  Schema,
  Semaphore,
} from 'effect'
import yauzl from 'yauzl'

import { Database, type DatabaseError } from '../db.ts'
import { describe as describeIngest, Ingest } from '../ingest.ts'
import { syncRuns } from '../schema.ts'
import { parisToday } from '../tools.ts'

import { type ApiFailure, GarminApi } from './api.ts'
import { GarminError } from './errors.ts'
import { type Account, GarminSession } from './session.ts'

// Garmin Connect → data/ → SQLite. Each run writes the raw files (each atomically: the ingest never
// reads half of one), then ingests them, and is recorded in sync_runs:
//
//   fit/YYYY/<activityId>.fit              the activity's original FIT file, once
//   connect/activities/YYYY/<id>.json      its summary (+ gear), again while it may still change
//   connect/daily/YYYY/<date>.json         stats, sleep, HRV, readiness, max metrics, predictions
//   connect/body/YYYY-MM.json              weigh-ins
//   connect/calendar/YYYY-MM.json          scheduled workouts, and connect/workouts/<id>.json
//
// Without `since`: from two days before the newest day already in data/, else 14 days back. With
// `since: 'all'`: the whole history, from the account's oldest activity. One failing call is a
// warning (the rest goes on, and a day with one is not written, to be fetched again); a refused
// session or a rate limit stops the run.
//
// The whole history (asked on /garmin) is a backfill: a second between days and downloads, files
// already there skipped, and resumed by the loop until one completes (after a rate limit, half an
// hour later). DATA_DIR/.backfill marks it pending.

// Days fetched again: Garmin still fills them (sleep, HRV, renamed activities)
const FRESH_DAYS = 3
const ACTIVITY_FRESH_DAYS = 14
const DEFAULT_BACK_DAYS = 14
const PAGE = 100
// 100 000 activities at most: a list that never ends is Garmin's bug, not a history
const MAX_OFFSET = 100_000
export const ALL = 'all'
// Past a month of days, the run paces itself
const BACKFILL_DAYS = 31
const BACKFILL_PAUSE = '1 second'
const BACKFILL_MARKER = '.backfill'

export interface SyncOutcome {
  readonly ok: boolean
  readonly logged_out: boolean
  readonly account: string | null
  readonly since: string | null
  readonly files_written: number
  readonly warnings: ReadonlyArray<string>
  readonly error: string | null
}

export type SyncRun = typeof syncRuns.$inferSelect

// Days as YYYY-MM-DD strings
export const addDays = (day: string, days: number) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10)
const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000)
const monthOf = (day: string) => `${day.slice(0, 7)}-01`
const nextMonth = (month: string) => {
  const date = new Date(`${month}T00:00:00Z`)
  date.setUTCMonth(date.getUTCMonth() + 1)
  return date.toISOString().slice(0, 10)
}
export const monthEnd = (month: string) => addDays(nextMonth(month), -1)
// The first day of each month from `from`'s to `to`'s
export const months = (from: string, to: string) => {
  const all: Array<string> = []
  for (let month = monthOf(from); month <= to; month = nextMonth(month)) all.push(month)
  return all
}
const min = (a: string, b: string) => (a < b ? a : b)

// The first .fit file of an "original" download (a zip)
const MAX_FIT_BYTES = 256 * 1024 * 1024
export const fitOfZip = (zip: Uint8Array) =>
  Effect.callback<Uint8Array | null, GarminError>((resume) => {
    const fail = (error: Error) =>
      resume(Effect.fail(new GarminError({ message: `the activity's zip: ${error.message}` })))
    yauzl.fromBuffer(Buffer.from(zip), { lazyEntries: true }, (error, archive) => {
      if (error !== null) {
        fail(error)
        return
      }
      archive.on('error', fail)
      archive.on('end', () => resume(Effect.succeed(null)))
      archive.on('entry', (entry: yauzl.Entry) => {
        if (!entry.fileName.toLowerCase().endsWith('.fit')) {
          archive.readEntry()
          return
        }
        // A FIT file is a few MB: a bigger one is a zip bomb, not read
        if (entry.uncompressedSize > MAX_FIT_BYTES) {
          archive.close()
          fail(new Error(`${entry.fileName}: ${entry.uncompressedSize} bytes, too big`))
          return
        }
        archive.openReadStream(entry, (streamError, stream) => {
          if (streamError !== null) {
            fail(streamError)
            return
          }
          const parts: Array<Buffer> = []
          stream.on('data', (part: Buffer) => parts.push(part))
          stream.on('error', fail)
          stream.on('end', () => {
            archive.close()
            resume(Effect.succeed(new Uint8Array(Buffer.concat(parts))))
          })
        })
      })
      archive.readEntry()
    })
  })

const ActivityItem = Schema.Struct({ activityId: Schema.Number, startTimeLocal: Schema.String })
const CalendarItem = Schema.Struct({
  itemType: Schema.optional(Schema.NullOr(Schema.String)),
  workoutId: Schema.optional(Schema.NullOr(Schema.Number)),
})
const decodeActivity = Schema.decodeUnknownOption(ActivityItem)
const decodeCalendarItem = Schema.decodeUnknownOption(CalendarItem)

const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

const accountName = (account: Account) => account.full_name ?? account.display_name

export class GarminSync extends Context.Service<
  GarminSync,
  {
    // One sync (one at a time: a second waits for the first); `since`: a day, or ALL
    readonly run: (options?: { readonly since?: string }) => Effect.Effect<SyncOutcome>
    readonly running: Effect.Effect<boolean>
    // Asks for the whole history: the loop fetches it now, and resumes it until it completes
    readonly backfill: Effect.Effect<void, GarminError>
    readonly backfilling: Effect.Effect<boolean>
    // Wakes the background loop now (after a login, or "sync now")
    readonly trigger: Effect.Effect<void>
    readonly recent: (limit: number) => Effect.Effect<ReadonlyArray<SyncRun>, DatabaseError>
    // Every SYNC_EVERY_HOURS (3 by default), or when triggered; while logged out it waits for a
    // new session (checked every minute: a CLI login is another process)
    readonly loop: Effect.Effect<never>
  }
>()('garmin/GarminSync') {
  static readonly layer = Layer.effect(
    GarminSync,
    Effect.gen(function* () {
      const api = yield* GarminApi
      const session = yield* GarminSession
      const ingest = yield* Ingest
      const { use } = yield* Database
      const fs = yield* FileSystem.FileSystem
      const dataDir = yield* Config.String('DATA_DIR')
      const everyHours = yield* Config.Number('SYNC_EVERY_HOURS').pipe(Config.withDefault(3))
      const lock = yield* Semaphore.make(1)
      const busy = yield* Ref.make(false)
      const wake = yield* Queue.sliding<void>(1)

      const now = Effect.map(Clock.currentTimeMillis, (ms) => new Date(ms).toISOString())

      const sync = (since: string | undefined, warnings: Array<string>, written: Ref.Ref<number>) =>
        Effect.gen(function* () {
          const exists = (path: string) =>
            fs.exists(join(dataDir, path)).pipe(Effect.orElseSucceed(() => false))
          const write = (path: string, data: unknown) =>
            Effect.gen(function* () {
              const target = join(dataDir, path)
              const partial = join(target, '..', `.${target.split('/').at(-1)}.partial`)
              yield* fs.makeDirectory(join(target, '..'), { recursive: true })
              if (data instanceof Uint8Array) yield* fs.writeFile(partial, data)
              else yield* fs.writeFileString(partial, JSON.stringify(data))
              yield* fs.rename(partial, target)
              yield* Ref.update(written, (n) => n + 1)
            }).pipe(
              Effect.mapError((error) => new GarminError({ message: `${path}: ${error.message}` }))
            )
          // The day of the account's oldest activity (the activity list, to its end), else the
          // default span
          const oldestActivityDay = (today: string) =>
            Effect.gen(function* () {
              let oldest: string | undefined
              for (let offset = 0; offset < MAX_OFFSET; offset += PAGE) {
                const items = yield* api.json(
                  '/activitylist-service/activities/search/activities',
                  {
                    start: offset,
                    limit: PAGE,
                  }
                )
                const list = Array.isArray(items) ? items : []
                for (const raw of list) {
                  const day = Option.getOrUndefined(decodeActivity(raw))?.startTimeLocal.slice(
                    0,
                    10
                  )
                  if (day !== undefined && /^\d{4}-\d{2}-\d{2}$/u.test(day)) {
                    oldest = oldest === undefined ? day : min(oldest, day)
                  }
                }
                if (list.length < PAGE) break
              }
              return oldest ?? addDays(today, -DEFAULT_BACK_DAYS)
            })
          // One call: null and a warning when it fails, so one endpoint never stops the run
          const call = <A>(what: string, effect: Effect.Effect<A, ApiFailure>) =>
            effect.pipe(
              Effect.catchTag('GarminError', (error) =>
                Effect.gen(function* () {
                  // A 404 is a day or an activity without that data
                  if (error.status !== 404) {
                    warnings.push(`${what}: ${error.message}`)
                    yield* Effect.logWarning(`${what} failed: ${error.message}`)
                  }
                  return null
                })
              )
            )

          const account = yield* api.profile
          // In the API's paths: escaped
          const name = encodeURIComponent(account.display_name)
          const today = yield* parisToday
          const start =
            since === ALL
              ? yield* oldestActivityDay(today)
              : (since ??
                Option.match(yield* newestDay, {
                  onNone: () => addDays(today, -DEFAULT_BACK_DAYS),
                  onSome: (day) => min(addDays(day, -(FRESH_DAYS - 1)), today),
                }))
          // Gentle on Garmin over a long span
          const pause =
            daysBetween(start, today) > BACKFILL_DAYS ? Effect.sleep(BACKFILL_PAUSE) : Effect.void
          yield* Effect.logInfo(`syncing ${accountName(account)} from ${start}`)

          // Activities, newest first, until one starts before `start`
          for (let offset = 0; offset < MAX_OFFSET; offset += PAGE) {
            const page = yield* call(
              'activities',
              api.json('/activitylist-service/activities/search/activities', {
                start: offset,
                limit: PAGE,
              })
            )
            const items = Array.isArray(page) ? page : []
            let past = false
            for (const raw of items) {
              const item = decodeActivity(raw)
              if (Option.isNone(item)) continue
              const { activityId: id, startTimeLocal } = item.value
              const day = startTimeLocal.slice(0, 10)
              // The day names the files: a date or nothing
              if (!/^\d{4}-\d{2}-\d{2}$/u.test(day) || !Number.isSafeInteger(id)) continue
              if (day < start) {
                past = true
                break
              }
              const year = day.slice(0, 4)
              const fit = `fit/${year}/${id}.fit`
              const summary = `connect/activities/${year}/${id}.json`
              if (!(yield* exists(fit))) {
                const zip = yield* call(
                  `FIT of ${id}`,
                  api.bytes(`/download-service/files/activity/${id}`)
                )
                yield* pause
                if (zip !== null) {
                  const bytes = yield* fitOfZip(zip).pipe(
                    Effect.catchTag('GarminError', (error) => {
                      warnings.push(`FIT of ${id}: ${error.message}`)
                      return Effect.succeed(null)
                    })
                  )
                  if (bytes === null) {
                    yield* Effect.logInfo(`activity ${id} has no FIT file`)
                  } else {
                    yield* write(fit, bytes)
                  }
                }
              }
              if (!(yield* exists(summary)) || daysBetween(day, today) <= ACTIVITY_FRESH_DAYS) {
                const gear = yield* call(
                  `gear of ${id}`,
                  api.json('/gear-service/gear/filterGear', { activityId: id })
                )
                yield* pause
                yield* write(summary, { ...record(raw), gear: gear ?? [] })
              }
            }
            if (past || items.length < PAGE) break
          }

          // Days: the race predictions by month, then each day's endpoints
          const predictions = new Map<string, unknown>()
          for (const month of months(start, today)) {
            const rows = yield* call(
              `race predictions ${month.slice(0, 7)}`,
              api.json(`/metrics-service/metrics/racepredictions/daily/${name}`, {
                fromCalendarDate: month,
                toCalendarDate: min(monthEnd(month), today),
              })
            )
            for (const row of Array.isArray(rows) ? rows : []) {
              const date = record(row)['calendarDate']
              if (typeof date === 'string') predictions.set(date, row)
            }
          }
          for (let day = start; day <= today; day = addDays(day, 1)) {
            const path = `connect/daily/${day.slice(0, 4)}/${day}.json`
            if ((yield* exists(path)) && daysBetween(day, today) >= FRESH_DAYS) continue
            const failedBefore = warnings.length
            const fetched = yield* Effect.all(
              {
                stats: call(
                  `stats ${day}`,
                  api.json(`/usersummary-service/usersummary/daily/${name}`, { calendarDate: day })
                ),
                sleep: call(
                  `sleep ${day}`,
                  api.json(`/wellness-service/wellness/dailySleepData/${name}`, {
                    date: day,
                    nonSleepBufferMinutes: 60,
                  })
                ),
                hrv: call(`hrv ${day}`, api.json(`/hrv-service/hrv/${day}`)),
                training_readiness: call(
                  `readiness ${day}`,
                  api.json(`/metrics-service/metrics/trainingreadiness/${day}`)
                ),
                training_status: call(
                  `training status ${day}`,
                  api.json(`/metrics-service/metrics/trainingstatus/aggregated/${day}`)
                ),
                max_metrics: call(
                  `max metrics ${day}`,
                  api.json(`/metrics-service/metrics/maxmet/daily/${day}/${day}`)
                ),
              },
              { concurrency: 3 }
            )
            yield* pause
            // A call failed: not written, so the next run (or backfill) fetches the day again
            if (warnings.length > failedBefore) continue
            yield* write(path, {
              date: day,
              fetched_at: yield* now,
              ...fetched,
              race_predictions: predictions.get(day) ?? null,
            })
          }

          // Weigh-ins, by month
          for (const month of months(start, today)) {
            const path = `connect/body/${month.slice(0, 7)}.json`
            if ((yield* exists(path)) && monthEnd(month) < addDays(today, -FRESH_DAYS)) continue
            const weighIns = yield* call(
              `body ${month.slice(0, 7)}`,
              api.json('/weight-service/weight/dateRange', {
                startDate: month,
                endDate: min(monthEnd(month), today),
              })
            )
            if (weighIns !== null) yield* write(path, weighIns)
          }

          // The calendar, last month (what was done) to two months ahead (the plan), and each
          // workout once (the months overlap, a routine is scheduled under one id)
          const workouts = new Set<number>()
          const calendarFrom = monthOf(addDays(monthOf(today), -1))
          for (const month of months(calendarFrom, addDays(monthOf(today), 62))) {
            const year = Number(month.slice(0, 4))
            const index = Number(month.slice(5, 7)) - 1
            const calendar = yield* call(
              `calendar ${month.slice(0, 7)}`,
              api.json(`/calendar-service/year/${year}/month/${index}`)
            )
            if (calendar === null) continue
            yield* write(`connect/calendar/${month.slice(0, 7)}.json`, calendar)
            const items = record(calendar)['calendarItems']
            for (const raw of Array.isArray(items) ? items : []) {
              const item = decodeCalendarItem(raw)
              const id = Option.isSome(item) ? item.value.workoutId : null
              if (Option.isNone(item) || item.value.itemType !== 'workout' || !id) continue
              if (workouts.has(id)) continue
              workouts.add(id)
              const workout = yield* call(
                `workout ${id}`,
                api.json(`/workout-service/workout/${id}`)
              )
              if (workout !== null) yield* write(`connect/workouts/${id}.json`, workout)
            }
          }
          return { account, since: start }
        })

      // The newest day in data/connect/daily/
      const newestDay = Effect.gen(function* () {
        const root = join(dataDir, 'connect', 'daily')
        const years = (yield* fs.readDirectory(root)).filter((y) => /^\d{4}$/u.test(y)).toSorted()
        for (const year of years.toReversed()) {
          const days = (yield* fs.readDirectory(join(root, year)))
            .filter((file) => /^\d{4}-\d{2}-\d{2}\.json$/u.test(file))
            .toSorted()
          const last = days.at(-1)
          if (last !== undefined) return Option.some(last.slice(0, 10))
        }
        return Option.none<string>()
      }).pipe(Effect.orElseSucceed(() => Option.none<string>()))

      const run = (options?: { readonly since?: string }) =>
        lock.withPermits(1)(
          Effect.gen(function* () {
            const saved = yield* session.load
            if (Option.isNone(saved)) {
              return {
                ok: false,
                logged_out: true,
                account: null,
                since: null,
                files_written: 0,
                warnings: [],
                error: 'no Garmin session: log in first',
              } satisfies SyncOutcome
            }
            yield* Ref.set(busy, true)
            const startedAt = yield* now
            const [row] = yield* use((db) =>
              db
                .insert(syncRuns)
                .values({
                  started_at: startedAt,
                  account: saved.value.account ? accountName(saved.value.account) : null,
                  since: options?.since ?? null,
                })
                .returning({ id: syncRuns.id })
                .all()
            )
            const warnings: Array<string> = []
            const written = yield* Ref.make(0)
            const result = yield* sync(options?.since, warnings, written).pipe(Effect.result)
            const failure = result._tag === 'Failure' ? result.failure : null
            const outcome: SyncOutcome = {
              ok: failure === null,
              logged_out: failure?._tag === 'NotLoggedIn',
              account:
                result._tag === 'Success'
                  ? accountName(result.success.account)
                  : saved.value.account
                    ? accountName(saved.value.account)
                    : null,
              since: result._tag === 'Success' ? result.success.since : (options?.since ?? null),
              files_written: yield* Ref.get(written),
              warnings,
              error: failure === null ? null : failure.message,
            }
            if (row !== undefined) {
              yield* use((db) =>
                db
                  .update(syncRuns)
                  .set({
                    finished_at: new Date().toISOString(),
                    ok: outcome.ok,
                    logged_out: outcome.logged_out,
                    account: outcome.account,
                    since: outcome.since,
                    files_written: outcome.files_written,
                    warnings: warnings.length === 0 ? null : JSON.stringify(warnings.slice(0, 20)),
                    error: outcome.error,
                  })
                  .where(eq(syncRuns.id, row.id))
                  .run()
              )
            }
            if (outcome.ok) {
              yield* Effect.logInfo(
                `sync done: ${outcome.files_written} file(s) written, ${warnings.length} warning(s)`
              )
            } else {
              yield* Effect.logError(`sync failed: ${outcome.error ?? ''}`)
            }
            // What was written, into SQLite now
            if (outcome.files_written > 0) {
              const summary = yield* ingest.run()
              yield* Effect.logInfo(`ingest: ${describeIngest(summary)}`)
            }
            return outcome
          }).pipe(
            Effect.ensuring(Ref.set(busy, false)),
            Effect.catchCause((cause) =>
              Effect.as(Effect.logError('sync crashed', cause), {
                ok: false,
                logged_out: false,
                account: null,
                since: null,
                files_written: 0,
                warnings: [],
                error: Cause.pretty(cause),
              } satisfies SyncOutcome)
            ),
            Effect.withSpan('GarminSync.run')
          )
        )

      const marker = join(dataDir, BACKFILL_MARKER)
      const backfilling = fs.exists(marker).pipe(Effect.orElseSucceed(() => false))
      const backfill = Effect.gen(function* () {
        yield* fs.makeDirectory(dataDir, { recursive: true })
        yield* fs.writeFileString(marker, `${yield* now}\n`)
        yield* Queue.offer(wake, undefined)
      }).pipe(
        Effect.mapError((error) => new GarminError({ message: `the backfill: ${error.message}` }))
      )

      const recent = (limit: number) =>
        use((db) => db.select().from(syncRuns).orderBy(desc(syncRuns.id)).limit(limit).all())

      const waitFor = (duration: string) =>
        Effect.raceFirst(Effect.sleep(duration as '1 minute'), Queue.take(wake))

      const loop = Effect.gen(function* () {
        // The session Garmin refused (its saved_at), not tried again until a new one replaces it
        let refused: string | undefined
        for (;;) {
          const saved = yield* session.load
          if (Option.isNone(saved) || saved.value.saved_at === refused) {
            yield* waitFor('1 minute')
            continue
          }
          const pending = yield* backfilling
          const outcome = yield* run(pending ? { since: ALL } : undefined)
          // The whole history fetched: done; else (a rate limit) resumed in half an hour
          if (pending && outcome.ok) yield* fs.remove(marker).pipe(Effect.ignore)
          // As saved after the run: a refresh during it may have saved it again
          const after = yield* session.load
          refused = outcome.logged_out
            ? Option.getOrUndefined(Option.map(after, (s) => s.saved_at))
            : undefined
          yield* waitFor(
            outcome.logged_out
              ? '1 minute'
              : pending && !outcome.ok
                ? '30 minutes'
                : `${everyHours * 60} minutes`
          )
        }
      })

      return GarminSync.of({
        run,
        running: Ref.get(busy),
        backfill,
        backfilling,
        trigger: Queue.offer(wake, undefined).pipe(Effect.asVoid),
        recent,
        loop,
      })
    })
  )

  // The background loop, with the app
  static readonly scheduler = Layer.effectDiscard(
    GarminSync.use((sync) => Effect.forkScoped(sync.loop))
  )
}
