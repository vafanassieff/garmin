import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { expect, layer } from '@effect/vitest'
import { Effect, Exit, Layer } from 'effect'

import { dataDir, rows, sql, testLayer } from '../../test/fixtures.ts'
import { Storage } from '../ingest.ts'

import { Journal } from './log.ts'

const TestLayer = testLayer(Journal.layer.pipe(Layer.provideMerge(Storage)))

const files = Effect.map(dataDir, (root) => {
  const directory = join(root, 'journal', '1970')
  return existsSync(directory) ? readdirSync(directory).toSorted() : []
})

// The test clock: frozen at 1970-01-01T00:00:00Z
layer(TestLayer)('Journal', (it) => {
  it.effect('writes each note to its own file, then ingests it', () =>
    Effect.gen(function* () {
      const journal = yield* Journal
      // A day or a text the schema refuses: nothing written
      for (const note of [
        { day: '23/11', text: 'Genou' },
        { text: '' },
        { text: 'x'.repeat(2001) },
      ]) {
        expect(Exit.isFailure(yield* journal.log(note).pipe(Effect.exit))).toBe(true)
      }
      expect(yield* files).toEqual([])

      const first = yield* journal.log({ text: 'Pointes au milieu du quadri' })
      expect(first).toEqual({
        time: '1970-01-01T00:00:00.000Z',
        day: '1970-01-01',
        text: 'Pointes au milieu du quadri',
      })
      // The same millisecond: the next one, never over the first
      const second = yield* journal.log({ day: '1969-12-31', text: 'Ampoule' })
      expect(second.time).toBe('1970-01-01T00:00:00.001Z')
      expect(yield* files).toEqual([
        '1970-01-01T00-00-00.000Z.json',
        '1970-01-01T00-00-00.001Z.json',
      ])
      expect(yield* rows(sql`SELECT time, day, text FROM journal ORDER BY time`)).toEqual([
        first,
        second,
      ])
    })
  )

  it.effect('never writes two notes at once over each other', () =>
    Effect.gen(function* () {
      const journal = yield* Journal
      const notes = yield* Effect.all(
        [journal.log({ text: 'x'.repeat(2000) }), journal.log({ text: 'b' })],
        { concurrency: 'unbounded' }
      )
      expect(new Set(notes.map((note) => note.time)).size).toBe(2)
      expect(yield* files).toEqual(
        expect.arrayContaining(notes.map((note) => `${note.time.replaceAll(':', '-')}.json`))
      )
    })
  )
})
