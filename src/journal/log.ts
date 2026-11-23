import { join } from 'node:path'

import { Clock, Config, Context, Effect, FileSystem, Layer, Schema, Semaphore } from 'effect'

import { parisToday } from '../days.ts'
import { writeAtomic } from '../files.ts'
import { Ingest } from '../ingest.ts'

import { type JournalNote, JournalNoteJson, notePath } from './note.ts'

// The journal's writer (the MCP's log_note): a note is checked, written to its own file in
// data/journal/, then ingested. Its file is never written over another's: two notes in the same
// millisecond take the next free one.

export class Journal extends Context.Service<
  Journal,
  {
    // The note as written; its day defaults to today in Paris
    readonly log: (note: {
      readonly day?: string | undefined
      readonly text: string
    }) => Effect.Effect<JournalNote, Schema.SchemaError>
  }
>()('garmin/Journal') {
  static readonly layer = Layer.effect(
    Journal,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const ingest = yield* Ingest
      const dataDir = yield* Config.String('DATA_DIR')
      const lock = yield* Semaphore.make(1)

      // The first instant from now whose file is free
      const freeTime = Effect.gen(function* () {
        let ms = yield* Clock.currentTimeMillis
        while (yield* fs.exists(join(dataDir, notePath(new Date(ms).toISOString())))) ms += 1
        return new Date(ms).toISOString()
      }).pipe(Effect.orDie)

      const log = Effect.fn('Journal.log')(function* (note: {
        readonly day?: string | undefined
        readonly text: string
      }) {
        const day = note.day ?? (yield* parisToday)
        return yield* lock.withPermits(1)(
          Effect.gen(function* () {
            const saved = yield* Schema.decodeUnknownEffect(JournalNoteJson)({
              time: yield* freeTime,
              day,
              text: note.text,
            })
            yield* writeAtomic(fs, join(dataDir, notePath(saved.time)), JSON.stringify(saved)).pipe(
              Effect.orDie
            )
            // On disk, it is saved: the ingest every 5 minutes files it if this one fails
            yield* ingest
              .run()
              .pipe(
                Effect.catchTag('DatabaseError', (error) =>
                  Effect.logWarning('journal: note saved, its ingest deferred', error)
                )
              )
            return saved
          })
        )
      })

      return Journal.of({ log })
    })
  )
}
