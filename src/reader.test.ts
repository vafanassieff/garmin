import { readdirSync } from 'node:fs'
import { dirname } from 'node:path'

import { expect, layer } from '@effect/vitest'
import { Effect, Fiber, Layer } from 'effect'

import { rows, sql, testConfig } from '../test/fixtures.ts'

import { Database } from './db.ts'
import { capRows } from './mcp.ts'
import { Reader } from './reader.ts'

const withTimeout = (reader: typeof Reader.layer) =>
  reader.pipe(Layer.provideMerge(Database.layer), Layer.provide(testConfig))

// SQLite's message, as the MCP returns it
const failure = (statement: string) =>
  Effect.gen(function* () {
    const reader = yield* Reader
    return (yield* Effect.flip(reader.query(statement))).message
  })

const dailyCount = rows(sql`SELECT count(*) AS count FROM daily`)

// Only the database and its WAL files, whatever the queries tried
const files = Effect.map(Database, ({ path }) => readdirSync(dirname(path)).toSorted())

const denied = /not authorized|authorization denied|readonly/u

layer(withTimeout(Reader.layer), { excludeTestServices: true })('Reader', (it) => {
  it.effect('reads tables and views, one statement at a time', () =>
    Effect.gen(function* () {
      const reader = yield* Reader
      expect(yield* reader.query('SELECT count(*) AS n FROM activity_summary')).toEqual({
        rows: [{ n: 0 }],
        total: 1,
      })
      expect((yield* reader.query('PRAGMA table_info(samples)')).total).toBe(10)
      expect(yield* failure('SELECT 1; SELECT 2')).toBe('Only one statement per query.')
      expect(yield* failure('SELECT 1; DELETE FROM daily')).toBe('Only one statement per query.')
      expect((yield* reader.query('SELECT 1 AS one; -- done\n;')).rows).toEqual([{ one: 1 }])
    })
  )

  it.effect('cannot write, open a transaction, change a pragma or touch other files', () =>
    Effect.gen(function* () {
      const before = yield* files
      const { path } = yield* Database
      for (const statement of [
        `INSERT INTO daily (day) VALUES ('2026-01-01')`,
        `UPDATE activities SET name = 'x'`,
        'DELETE FROM samples',
        'DROP TABLE samples',
        'CREATE TEMP TABLE notes (a)',
        'BEGIN',
        'PRAGMA query_only = OFF',
        'PRAGMA foreign_keys = OFF',
        `ATTACH '${dirname(path)}/other.db' AS other`,
        `VACUUM INTO '${dirname(path)}/copy.db'`,
        `SELECT load_extension('/tmp/evil')`,
      ]) {
        expect(yield* failure(statement), statement).toMatch(denied)
      }
      expect(yield* dailyCount).toEqual([{ count: 0 }])
      expect(yield* files).toEqual(before)
    })
  )

  it.effect('caps the rows, counting them all', () =>
    Effect.gen(function* () {
      const reader = yield* Reader
      const capped = capRows(
        yield* reader.query(
          'WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 5001) SELECT i FROM n'
        )
      )
      expect(capped.note).toBe('Truncated to 5000 of 5001 rows. Aggregate or add a LIMIT.')
      expect(capped.rows).toHaveLength(5000)
    })
  )

  it.effect('lists the tables and views', () =>
    Effect.gen(function* () {
      const reader = yield* Reader
      const columns = yield* reader.columns
      expect([...new Set(columns.map((column) => column.table_name))]).toEqual([
        'activities',
        'activity_summary',
        'body',
        'daily',
        'laps',
        'planned_workouts',
        'raw_files',
        'samples',
        'sync_runs',
        'weekly',
      ])
    })
  )
})

layer(withTimeout(Reader.layerWithTimeout('1 second')), { excludeTestServices: true })(
  'Reader, past its timeout',
  (it) => {
    it.effect('kills the query, without blocking the app', () =>
      Effect.gen(function* () {
        const reader = yield* Reader
        const runaway = yield* Effect.forkChild(
          failure(
            'WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n) SELECT count(*) FROM n'
          )
        )
        expect(yield* dailyCount).toEqual([{ count: 0 }])
        expect(yield* Fiber.join(runaway)).toBe('Query cancelled after 1s.')
        expect((yield* reader.query('SELECT 1 AS one')).rows).toEqual([{ one: 1 }])
      })
    )
  }
)
