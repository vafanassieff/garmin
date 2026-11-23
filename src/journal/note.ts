import { Schema } from 'effect'

// The user's journal, without I/O: one note per file in data/journal/YYYY/ (the source of truth, as
// every file of data/), named by the instant it was written, its key

export const JournalNoteJson = Schema.Struct({
  // The ISO instant it was written
  time: Schema.String,
  // The day it is about (its own pattern: the ingest's CLI does not load the API's)
  day: Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/u)),
  text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2000)),
})
export type JournalNote = typeof JournalNoteJson.Type

// Its file, relative to data/ (no ':' in a file name)
export const notePath = (time: string) =>
  `journal/${time.slice(0, 4)}/${time.replaceAll(':', '-')}.json`

export const decodeNote = Schema.decodeUnknownOption(JournalNoteJson)
