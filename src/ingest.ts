import { join } from 'node:path'
import process from 'node:process'

import * as NodeRuntime from '@effect/platform-node/NodeRuntime'
import * as NodeServices from '@effect/platform-node/NodeServices'
import { and, eq, getTableColumns, getTableName, gte, lte, sql } from 'drizzle-orm'
import type { SQLiteTable } from 'drizzle-orm/sqlite-core'
import { Config, Console, Context, Effect, FileSystem, Layer, Option, Schedule } from 'effect'
import { Command, Flag } from 'effect/cli'

import {
  apiActivity,
  apiBody,
  apiDaily,
  exportActivity,
  exportBody,
  exportDaily,
  plannedFromCalendar,
  type ActivitySummary,
  type BodyRow,
  type DailyRow,
} from './connect.ts'
import { Database, type DatabaseError } from './db.ts'
import { parseFit, type FitActivity } from './fit.ts'
import { activities, body, daily, laps, plannedWorkouts, rawFiles, samples } from './schema.ts'

// data/ → SQLite. The files are the source of truth (see README.md): each pass reads only those
// whose size or mtime changed since the last, and --rebuild empties the tables and reads them all.
// Order matters where two files fill the same row: the export's wellness first, then Garmin
// Connect's daily files over it (a field neither erases with a null).
//   node src/ingest.ts [--rebuild]

export interface IngestSummary {
  readonly files: number
  readonly activities: number
  readonly days: number
  readonly weighIns: number
  readonly plannedWorkouts: number
  readonly errors: ReadonlyArray<string>
}

type Kind =
  | { readonly kind: 'fit'; readonly id: number }
  | { readonly kind: 'summary'; readonly id: number; readonly exported: boolean }
  | { readonly kind: 'daily' }
  | { readonly kind: 'body' }
  | { readonly kind: 'calendar' }
  | { readonly kind: 'workout'; readonly id: number }
  | { readonly kind: 'export' }

// What a path of data/ holds, from its place (null: not ours, e.g. the sync's partial file)
export const classify = (path: string): Kind | null => {
  let match = /^fit\/\d{4}\/(\d+)\.fit$/u.exec(path)
  if (match) return { kind: 'fit', id: Number(match[1]) }
  match = /^connect\/activities\/\d{4}\/(\d+)(\.export)?\.json$/u.exec(path)
  if (match) return { kind: 'summary', id: Number(match[1]), exported: match[2] !== undefined }
  if (/^connect\/daily\/\d{4}\/\d{4}-\d{2}-\d{2}\.json$/u.test(path)) return { kind: 'daily' }
  if (/^connect\/body\/\d{4}-\d{2}\.json$/u.test(path)) return { kind: 'body' }
  if (/^connect\/calendar\/\d{4}-\d{2}\.json$/u.test(path)) return { kind: 'calendar' }
  match = /^connect\/workouts\/(\d+)\.json$/u.exec(path)
  if (match) return { kind: 'workout', id: Number(match[1]) }
  if (/^export\/.+\.json$/u.test(path)) return { kind: 'export' }
  return null
}

// SQLite caps a statement at 32766 parameters: 10 columns × 3000 samples stays under
const chunkSize = 3000

const chunks = <A>(rows: ReadonlyArray<A>) =>
  Array.from({ length: Math.ceil(rows.length / chunkSize) }, (_, index) =>
    rows.slice(index * chunkSize, (index + 1) * chunkSize)
  )

// ON CONFLICT: every column but the key takes the new value unless it is null
const coalesceAll = (table: SQLiteTable, key: string) =>
  Object.fromEntries(
    Object.keys(getTableColumns(table))
      .filter((column) => column !== key)
      .map((column) => [
        column,
        sql.raw(`coalesce(excluded.${column}, ${getTableName(table)}.${column})`),
      ])
  )

// The local wall time of an instant in Paris, for a FIT file without its own offset
const parisLocal = (instant: string) =>
  new Date(instant)
    .toLocaleString('sv-SE', { timeZone: 'Europe/Paris' })
    .replace(' ', 'T')
    .slice(0, 19)

const localOf = (fit: FitActivity) =>
  fit.utc_offset_s === null
    ? parisLocal(fit.start_time)
    : new Date(Date.parse(fit.start_time) + fit.utc_offset_s * 1000).toISOString().slice(0, 19)

const definedOnly = (row: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(row).filter(([, value]) => value !== undefined))

// One activity from its FIT file and Connect summary: the FIT file's measures, Connect's name,
// type, load, training effect, moving time and gear (computed by Garmin Connect, or edited there)
export const activityRow = (
  id: number,
  fit: FitActivity | null,
  summary: ActivitySummary | null,
  files: { readonly fit: string | null; readonly summary: string | null }
): typeof activities.$inferInsert | null => {
  if (fit === null && summary === null) return null
  const { laps: _laps, samples: _samples, utc_offset_s: _offset, ...measures } = fit ?? {}
  const startLocal = summary?.start_local ?? (fit === null ? null : localOf(fit))
  const startTime = fit?.start_time ?? summary?.start_time
  if (startLocal === null || startTime === undefined) return null
  const fromFit = definedOnly(
    Object.fromEntries(Object.entries(measures).filter(([, value]) => value !== null))
  )
  return {
    ...definedOnly({ ...summary }),
    ...fromFit,
    id,
    name: summary?.name ?? fit?.workout_name ?? null,
    sport: summary?.sport ?? fit?.fit_sport ?? 'unknown',
    start_time: startTime,
    start_local: startLocal,
    day: startLocal.slice(0, 10),
    moving_s: summary?.moving_s ?? fit?.moving_s ?? null,
    training_load: summary?.training_load ?? fit?.training_load ?? null,
    aerobic_te: summary?.aerobic_te ?? fit?.aerobic_te ?? null,
    anaerobic_te: summary?.anaerobic_te ?? fit?.anaerobic_te ?? null,
    te_label: summary?.te_label ?? null,
    vo2max: summary?.vo2max ?? null,
    gear: summary?.gear ?? null,
    fit_file: files.fit,
    summary_file: files.summary,
    updated_at: new Date().toISOString(),
  }
}

export class Ingest extends Context.Service<
  Ingest,
  {
    readonly run: (options?: {
      readonly rebuild?: boolean
    }) => Effect.Effect<IngestSummary, DatabaseError>
  }
>()('garmin/Ingest') {
  static readonly layer = Layer.effect(
    Ingest,
    Effect.gen(function* () {
      const { use } = yield* Database
      const fs = yield* FileSystem.FileSystem
      const dataDir = yield* Config.String('DATA_DIR')

      const readBytes = (path: string) => fs.readFile(join(dataDir, path))
      const readJson = (path: string) =>
        readBytes(path).pipe(
          Effect.flatMap((bytes) =>
            Effect.try({
              try: (): unknown => JSON.parse(new TextDecoder().decode(bytes)),
              catch: (error) => new Error(`${path}: ${String(error)}`),
            })
          )
        )

      // Every file of data/ ours, with its size and mtime
      const list = Effect.gen(function* () {
        const exists = yield* fs.exists(dataDir)
        if (!exists) return []
        const paths = yield* fs.readDirectory(dataDir, { recursive: true })
        return yield* Effect.forEach(
          paths.map((path) => path.replaceAll('\\', '/')).filter((path) => classify(path) !== null),
          (path) =>
            fs.stat(join(dataDir, path)).pipe(
              Effect.map((info) => ({
                path,
                size: Number(info.size),
                mtime_ms: Option.match(info.mtime, { onNone: () => 0, onSome: (d) => d.getTime() }),
                kind: classify(path),
              }))
            )
        )
      }).pipe(Effect.orDie)

      const run = Effect.fn('Ingest.run')(function* (options?: { readonly rebuild?: boolean }) {
        const rebuild = options?.rebuild === true
        if (rebuild) {
          yield* use((db) =>
            db.transaction((tx) => {
              for (const table of [
                samples,
                laps,
                activities,
                daily,
                body,
                plannedWorkouts,
                rawFiles,
              ]) {
                tx.delete(table).run()
              }
            })
          )
        }
        const files = yield* list
        const known = new Map(
          (yield* use((db) => db.select().from(rawFiles).all())).map((row) => [row.path, row])
        )
        const changed = files.filter((file) => {
          const seen = known.get(file.path)
          return seen === undefined || seen.size !== file.size || seen.mtime_ms !== file.mtime_ms
        })
        const errors: Array<string> = []
        const done = (
          file: { readonly path: string; readonly size: number; readonly mtime_ms: number },
          error: string | null
        ) => {
          if (error !== null) errors.push(`${file.path}: ${error}`)
          return use((db) =>
            db
              .insert(rawFiles)
              .values({ path: file.path, size: file.size, mtime_ms: file.mtime_ms, error })
              .onConflictDoUpdate({
                target: rawFiles.path,
                set: {
                  size: file.size,
                  mtime_ms: file.mtime_ms,
                  error,
                  ingested_at: new Date().toISOString(),
                },
              })
              .run()
          )
        }
        const failure = (error: unknown) => (error instanceof Error ? error.message : String(error))

        const upsertDaily = (rows: ReadonlyArray<DailyRow>) =>
          rows.length === 0
            ? Effect.void
            : use((db) =>
                db.transaction((tx) => {
                  for (const chunk of chunks(rows)) {
                    tx.insert(daily)
                      .values(
                        chunk.map((row) =>
                          Object.assign(row, { updated_at: new Date().toISOString() })
                        )
                      )
                      .onConflictDoUpdate({ target: daily.day, set: coalesceAll(daily, 'day') })
                      .run()
                  }
                })
              )
        const upsertBody = (rows: ReadonlyArray<BodyRow>) =>
          rows.length === 0
            ? Effect.void
            : use((db) =>
                db
                  .insert(body)
                  .values([...rows])
                  .onConflictDoUpdate({ target: body.time, set: coalesceAll(body, 'time') })
                  .run()
              )

        let days = 0
        let weighIns = 0

        // The export's wellness, then Connect's days over it
        for (const file of changed.filter((f) => f.kind?.kind === 'export')) {
          const outcome = yield* readJson(file.path).pipe(
            Effect.map((json) => ({ days: exportDaily(json), weighIns: exportBody(json) })),
            Effect.result
          )
          if (outcome._tag === 'Failure') {
            yield* done(file, failure(outcome.failure))
            continue
          }
          yield* upsertDaily(outcome.success.days)
          yield* upsertBody(outcome.success.weighIns)
          days += outcome.success.days.length
          weighIns += outcome.success.weighIns.length
          yield* done(file, null)
        }

        for (const file of changed.filter((f) => f.kind?.kind === 'daily')) {
          const json = yield* readJson(file.path).pipe(Effect.option)
          const row = Option.isSome(json) ? apiDaily(json.value) : null
          if (row !== null) {
            yield* upsertDaily([row])
            days += 1
          }
          yield* done(file, row === null ? 'not a daily file' : null)
        }

        for (const file of changed.filter((f) => f.kind?.kind === 'body')) {
          const json = yield* readJson(file.path).pipe(Effect.option)
          const month = Option.isSome(json) ? apiBody(json.value) : null
          if (month !== null) {
            yield* use((db) =>
              db.transaction((tx) => {
                tx.delete(body)
                  .where(and(gte(body.day, month.start), lte(body.day, month.end)))
                  .run()
                if (month.rows.length > 0)
                  tx.insert(body).values(month.rows).onConflictDoNothing().run()
              })
            )
            weighIns += month.rows.length
          }
          yield* done(file, month === null ? 'not a body composition file' : null)
        }

        // Activities: each one touched by a changed FIT file or summary, rebuilt from both
        const byId = new Map<number, { fit?: string; summary?: string; exported?: string }>()
        for (const file of files) {
          const kind = file.kind
          if (kind?.kind === 'fit') byId.set(kind.id, { ...byId.get(kind.id), fit: file.path })
          if (kind?.kind === 'summary') {
            byId.set(kind.id, {
              ...byId.get(kind.id),
              [kind.exported ? 'exported' : 'summary']: file.path,
            })
          }
        }
        const touched = new Set(
          changed.flatMap((file) =>
            file.kind?.kind === 'fit' || file.kind?.kind === 'summary' ? [file.kind.id] : []
          )
        )
        let activityCount = 0
        for (const id of touched) {
          yield* Effect.yieldNow
          const paths = byId.get(id) ?? {}
          const summaryPath = paths.summary ?? paths.exported ?? null
          const fitOutcome =
            paths.fit === undefined
              ? null
              : yield* readBytes(paths.fit).pipe(Effect.flatMap(parseFit), Effect.result)
          const fit = fitOutcome?._tag === 'Success' ? fitOutcome.success : null
          const summaryJson =
            summaryPath === null ? Option.none() : yield* readJson(summaryPath).pipe(Effect.option)
          const summary = Option.isNone(summaryJson)
            ? null
            : Option.getOrNull(
                summaryPath === paths.summary
                  ? apiActivity(summaryJson.value)
                  : exportActivity(summaryJson.value)
              )
          const row = activityRow(id, fit, summary, {
            fit: fit === null ? null : (paths.fit ?? null),
            summary: summary === null ? null : summaryPath,
          })
          if (row !== null) {
            yield* use((db) =>
              db.transaction(
                (tx) => {
                  tx.delete(samples).where(eq(samples.activity_id, id)).run()
                  tx.delete(laps).where(eq(laps.activity_id, id)).run()
                  tx.delete(activities).where(eq(activities.id, id)).run()
                  tx.insert(activities).values(row).run()
                  if (fit !== null && fit.laps.length > 0) {
                    tx.insert(laps)
                      .values(fit.laps.map((lap) => ({ ...lap, activity_id: id })))
                      .run()
                  }
                  for (const chunk of chunks(fit?.samples ?? [])) {
                    tx.insert(samples)
                      .values(chunk.map((sample) => Object.assign(sample, { activity_id: id })))
                      .run()
                  }
                },
                { behavior: 'immediate' }
              )
            )
            activityCount += 1
          }
          for (const file of changed) {
            if (file.path === paths.fit) {
              yield* done(file, fitOutcome?._tag === 'Failure' ? fitOutcome.failure.message : null)
            } else if (file.path === paths.summary || file.path === paths.exported) {
              const used = file.path === summaryPath
              yield* done(file, used && summary === null ? 'not an activity summary' : null)
            }
          }
        }

        // The calendar: rebuilt from every month's file once one of them or a workout changed
        let planned = 0
        if (changed.some((f) => f.kind?.kind === 'calendar' || f.kind?.kind === 'workout')) {
          const workouts = new Map<number, unknown>()
          for (const file of files) {
            if (file.kind?.kind !== 'workout') continue
            const json = yield* readJson(file.path).pipe(Effect.option)
            if (Option.isSome(json)) workouts.set(file.kind.id, json.value)
          }
          const rows = new Map<number, typeof plannedWorkouts.$inferInsert>()
          for (const file of files.filter((f) => f.kind?.kind === 'calendar')) {
            const json = yield* readJson(file.path).pipe(Effect.option)
            if (Option.isNone(json)) continue
            for (const row of plannedFromCalendar(json.value, (id) => workouts.get(id))) {
              if (row.id !== undefined) rows.set(row.id, row)
            }
          }
          yield* use((db) =>
            db.transaction((tx) => {
              tx.delete(plannedWorkouts).run()
              if (rows.size > 0)
                tx.insert(plannedWorkouts)
                  .values([...rows.values()])
                  .run()
            })
          )
          planned = rows.size
          for (const file of changed) {
            if (file.kind?.kind === 'calendar' || file.kind?.kind === 'workout') {
              yield* done(file, null)
            }
          }
        }

        return {
          files: changed.length,
          activities: activityCount,
          days,
          weighIns,
          plannedWorkouts: planned,
          errors,
        }
      })

      return Ingest.of({ run })
    })
  )

  // Every 5 minutes: what landed in data/ since (a backfill)
  static readonly scheduler = Layer.effectDiscard(
    Effect.gen(function* () {
      const ingest = yield* Ingest
      yield* ingest.run().pipe(
        Effect.tap((summary) =>
          summary.files === 0 ? Effect.void : Effect.logInfo(describe(summary))
        ),
        Effect.tap((summary) =>
          summary.errors.length === 0 ? Effect.void : Effect.logWarning(summary.errors.join('\n'))
        ),
        Effect.catchCause((cause) => Effect.logError('ingest failed', cause)),
        Effect.repeat(Schedule.spaced('5 minutes')),
        Effect.forkScoped
      )
    })
  )
}

export const describe = (summary: IngestSummary) =>
  `${summary.files} file(s): ${summary.activities} activities, ${summary.days} days, ${summary.weighIns} weigh-ins, ${summary.plannedWorkouts} planned workouts${summary.errors.length === 0 ? '' : `, ${summary.errors.length} error(s)`}`

const ingest = Command.make(
  'ingest',
  {
    rebuild: Flag.Boolean('rebuild').pipe(
      Flag.withDescription('Empty the tables and read every file of data/ again'),
      Flag.withDefault(false)
    ),
  },
  Effect.fn(function* ({ rebuild }) {
    const summary = yield* Ingest.use((service) => service.run({ rebuild }))
    yield* Console.log(describe(summary))
    for (const error of summary.errors) yield* Console.error(error)
    if (summary.errors.length > 0) process.exitCode = 1
  })
).pipe(Command.withDescription('Ingest the files of DATA_DIR into DATABASE_PATH'))

if (import.meta.main) {
  ingest.pipe(
    Command.run({ version: '1.0.0' }),
    Effect.provide(
      Ingest.layer.pipe(Layer.provideMerge(Database.layer), Layer.provideMerge(NodeServices.layer))
    ),
    NodeRuntime.runMain
  )
}
