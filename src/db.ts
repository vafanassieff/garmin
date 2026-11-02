import process from 'node:process'
import { DatabaseSync } from 'node:sqlite'

import { drizzle, type NodeSQLiteDatabase } from 'drizzle-orm/node-sqlite'
import { migrate } from 'drizzle-orm/node-sqlite/migrator'
import { Config, Context, Effect, Layer, Schedule, Schema } from 'effect'

// The SQL files drizzle-kit generates from schema.ts, relative to the working directory: the app's
// root in dev and tests, /app in the image (the server is bundled into .output, away from them)
export const migrationsFolder = 'drizzle'

export class DatabaseError extends Schema.TaggedError<DatabaseError>()('DatabaseError', {
  cause: Schema.Defect(),
}) {}

// A connection to the app's file, beside the others: WAL lets readers work during a write, and a
// writer waits up to `timeout` ms for another's lock (blocking its thread meanwhile)
export const openDatabase = (path: string, timeout = 5000) => {
  const client = new DatabaseSync(path, { timeout })
  client.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL')
  return client
}

// SQLITE_BUSY (5) and its extended codes, wherever drizzle wrapped it: another connection's lock
const busy = (cause: unknown): boolean =>
  typeof cause === 'object' &&
  cause !== null &&
  (('errcode' in cause && typeof cause.errcode === 'number' && cause.errcode % 256 === 5) ||
    ('cause' in cause && busy(cause.cause)))

// Tried again while the lock is busy: every 5ms doubling up to 50ms, for 30s at most (a CLI's
// ingest or backfill beside the app's)
const whileBusy = Schedule.min([
  Schedule.exponential('5 millis'),
  Schedule.spaced('50 millis'),
]).pipe(Schedule.upTo({ duration: '30 seconds' }))

// One SQLite file (DATABASE_PATH), migrated before anything uses it. node:sqlite is synchronous:
// each call runs to completion, so a transaction never interleaves with another. WAL lets the MCP's
// read-only connections and the CLIs work beside the app. A call never waits
// for another connection's lock in place (that would block every request): it fails at once and
// is run again after a pause, so each call must be one statement or one transaction.
export class Database extends Context.Service<
  Database,
  {
    readonly path: string
    readonly use: <A>(run: (db: NodeSQLiteDatabase) => A) => Effect.Effect<A, DatabaseError>
  }
>()('garmin/Database') {
  static readonly layer = Layer.effect(
    Database,
    Effect.gen(function* () {
      const path = yield* Config.String('DATABASE_PATH')
      // Health data: every file this process creates (SQLite, data/, the sessions) is its user's
      // alone, 0600 in 0700, whatever the umask it was started with
      yield* Effect.sync(() => process.umask(0o077))
      const client = yield* Effect.acquireRelease(
        Effect.try({
          try: () => openDatabase(path, 0),
          catch: (cause) => new DatabaseError({ cause }),
        }),
        (opened) => Effect.sync(() => opened.close())
      )
      const db = drizzle({ client })
      const use = <A>(run: (db: NodeSQLiteDatabase) => A) =>
        Effect.try({ try: () => run(db), catch: (cause) => new DatabaseError({ cause }) }).pipe(
          Effect.retry({ while: (error) => busy(error.cause), schedule: whileBusy })
        )
      yield* use((db) => migrate(db, { migrationsFolder }))
      return Database.of({ path, use })
    })
  )
}
