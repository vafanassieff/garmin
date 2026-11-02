import { join } from 'node:path'
import process from 'node:process'

import * as NodeServices from '@effect/platform-node/NodeServices'
import { Context, Duration, Effect, Layer, Schema, Semaphore } from 'effect'
import { ChildProcess, ChildProcessSpawner } from 'effect/process'

import { Database } from './db.ts'

export const MAX_ROWS = 5000
const QUERIES_AT_ONCE = 4

export class QueryError extends Schema.TaggedError<QueryError>()('QueryError', {
  message: Schema.String,
}) {}

const ColumnSchema = Schema.Struct({
  table_name: Schema.String,
  column_name: Schema.String,
  data_type: Schema.String,
  not_null: Schema.Number,
})
export type Column = typeof ColumnSchema.Type
const decodeColumns = Schema.decodeUnknownEffect(Schema.Array(ColumnSchema))

const Outcome = Schema.fromJsonString(
  Schema.Union([
    Schema.Struct({
      rows: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
      total: Schema.Number,
    }),
    Schema.Struct({ error: Schema.String }),
  ])
)
const decodeOutcome = Schema.decodeUnknownEffect(Outcome)

// Run from source, relative to the working directory, like the migrations (see db.ts)
const script = join('src', 'read-only.ts')

// Every table and view with its columns, the generated ones included
const columnsQuery = `
  SELECT m.name AS table_name, c.name AS column_name, c.type AS data_type, c."notnull" AS not_null
  FROM sqlite_schema m, pragma_table_xinfo(m.name) c
  WHERE m.type IN ('table', 'view') AND m.name NOT LIKE 'sqlite%' AND m.name NOT LIKE '%drizzle%'
  ORDER BY m.name, c.cid`

// Read-only SQL for the MCP, each statement in its own short-lived process over a read-only
// connection (see read-only.ts): killed past the timeout, as node:sqlite cannot interrupt a query
// and would block the app meanwhile.
export class Reader extends Context.Service<
  Reader,
  {
    // The first MAX_ROWS rows, and how many there were
    readonly query: (statement: string) => Effect.Effect<
      {
        readonly rows: ReadonlyArray<Record<string, unknown>>
        readonly total: number
      },
      QueryError
    >
    readonly columns: Effect.Effect<ReadonlyArray<Column>, QueryError>
  }
>()('garmin/Reader') {
  static readonly layerWithTimeout = (timeout: Duration.Input) =>
    Layer.effect(
      Reader,
      Effect.gen(function* () {
        const { path } = yield* Database
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner

        // A few processes at a time, the others wait
        const permits = yield* Semaphore.make(QUERIES_AT_ONCE)

        const query = Effect.fn('Reader.query')(function* (statement: string) {
          const output = yield* spawner
            .string(
              ChildProcess.make(process.execPath, [script, statement, String(MAX_ROWS)], {
                // The database and the time zone (SQLite's 'localtime'): not the password hash nor
                // the rest of the app's environment
                env: {
                  DATABASE_PATH: path,
                  ...(process.env['TZ'] === undefined ? {} : { TZ: process.env['TZ'] }),
                },
                extendEnv: false,
                killSignal: 'SIGKILL',
              })
            )
            .pipe(
              Effect.timeoutOrElse({
                duration: timeout,
                orElse: () =>
                  Effect.fail(
                    new QueryError({
                      message: `Query cancelled after ${Duration.format(Duration.fromInputUnsafe(timeout))}.`,
                    })
                  ),
              }),
              Effect.catchTag('PlatformError', (error) =>
                Effect.fail(new QueryError({ message: error.message }))
              ),
              permits.withPermits(1)
            )
          const outcome = yield* decodeOutcome(output).pipe(
            Effect.mapError(() => new QueryError({ message: 'The query process failed.' }))
          )
          if ('error' in outcome) return yield* new QueryError({ message: outcome.error })
          return outcome
        })

        const columns = query(columnsQuery).pipe(
          Effect.flatMap(({ rows }) => decodeColumns(rows)),
          Effect.catchTag('SchemaError', (error) =>
            Effect.fail(new QueryError({ message: error.message }))
          )
        )

        return Reader.of({ query, columns })
      })
    ).pipe(Layer.provide(NodeServices.layer))

  static readonly layer = Reader.layerWithTimeout('30 seconds')
}
