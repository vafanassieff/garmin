import { createWriteStream } from 'node:fs'
import { mkdir, mkdtemp, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import process from 'node:process'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'

import * as NodeRuntime from '@effect/platform-node/NodeRuntime'
import * as NodeServices from '@effect/platform-node/NodeServices'
import { Config, Console, Effect, Layer, Predicate, Schema } from 'effect'
import { Argument, Command } from 'effect/cli'
import yauzl from 'yauzl'

import { exportActivity, type ActivitySummary } from './connect.ts'
import { Database } from './db.ts'
import { fitFileType, fitStart } from './fit.ts'
import { describe as describeIngest, Ingest } from './ingest.ts'

// Garmin's "Export your data" zip (account settings → data management) → data/, then ingested:
//   node src/export.ts <export.zip>
// - DI_CONNECT/DI-Connect-Fitness/*summarizedActivities*.json: one summary per activity, written
//   to connect/activities/YYYY/<id>.export.json (the sync's own summary wins over it, see ingest.ts)
// - DI_CONNECT/DI-Connect-Uploaded-Files/*.zip: every file the devices uploaded. An activity's FIT
//   file is matched to its Connect activity by its start (the files are not named by activity id)
//   and written to fit/YYYY/<id>.fit, unless the sync already has it; one no summary matches goes
//   to fit/unmatched/, kept but not ingested. Other FIT files (settings, monitoring) and GPX/TCX
//   files are skipped.
// - DI-Connect-Wellness, -Aggregator and -Metrics JSON files (sleep, daily summaries, HRV,
//   readiness, VO2max, race predictions, weight): extracted as they are to export/<zip name>/.
// Importing the same export again rewrites the same files: nothing is counted twice.

export class ExportError extends Schema.TaggedError<ExportError>()('ExportError', {
  message: Schema.String,
}) {}

export interface ExportSummary {
  readonly summaries: number
  readonly fitMatched: number
  readonly fitKept: number
  readonly fitUnmatched: number
  readonly fitSkipped: number
  readonly wellnessFiles: number
}

type Entry = {
  readonly name: string
  // In memory: a JSON or FIT file, refused past MAX_IN_MEMORY (a zip bomb)
  readonly read: () => Promise<Buffer>
  // Streamed to a file, refused past MAX_ON_DISK: the inner zips of uploads
  readonly saveTo: (path: string) => Promise<void>
}

// The biggest summaries file of an export is a few MB, a FIT file a few
const MAX_IN_MEMORY = 256 * 1024 * 1024
// An inner zip of uploads is a few GB at most: past that it would only fill the disk
const MAX_ON_DISK = 8 * 1024 * 1024 * 1024

const openZip = promisify<string, yauzl.Options, yauzl.ZipFile>(yauzl.open)

// The next entry of a zip opened with lazyEntries, null at its end
const nextEntry = (zip: yauzl.ZipFile) =>
  new Promise<yauzl.Entry | null>((resolve, reject) => {
    const settle = (entry: yauzl.Entry | null, error?: Error) => {
      zip.removeAllListeners('entry').removeAllListeners('end').removeAllListeners('error')
      if (error === undefined) resolve(entry)
      else reject(error)
    }
    zip.once('entry', (entry: yauzl.Entry) => settle(entry))
    zip.once('end', () => settle(null))
    zip.once('error', (error: Error) => settle(null, error))
    zip.readEntry()
  })

// Every file of a zip, one at a time: an export is gigabytes, never read whole
async function* entries(path: string): AsyncGenerator<Entry> {
  const zip = await openZip(path, { lazyEntries: true, autoClose: false })
  const openStream = promisify(zip.openReadStream.bind(zip))
  try {
    for (let entry = await nextEntry(zip); entry !== null; entry = await nextEntry(zip)) {
      if (entry.fileName.endsWith('/')) continue
      const current = entry
      yield {
        name: current.fileName,
        read: async () => {
          // yauzl checks that the entry inflates to the size it declares
          if (current.uncompressedSize > MAX_IN_MEMORY) {
            throw new Error(`${current.fileName}: ${current.uncompressedSize} bytes, too big`)
          }
          return Buffer.concat(await (await openStream(current)).toArray())
        },
        saveTo: async (path) => {
          if (current.uncompressedSize > MAX_ON_DISK) {
            throw new Error(`${current.fileName}: ${current.uncompressedSize} bytes, too big`)
          }
          return pipeline(await openStream(current), createWriteStream(path))
        },
      }
    }
  } finally {
    zip.close()
  }
}

// Beside the target, then renamed: the app's ingest never reads half a file
const writeAtomically = async (path: string, data: Uint8Array | string) => {
  await mkdir(dirname(path), { recursive: true })
  const partial = join(dirname(path), `.${basename(path)}.partial`)
  await writeFile(partial, data)
  await rename(partial, path)
}

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false
  )

const isSummaries = (name: string) =>
  /DI-Connect-Fitness\/[^/]*summarizedActivities[^/]*\.json$/u.test(name)
const isUploads = (name: string) => /DI-Connect-Uploaded-Files\/[^/]*\.zip$/u.test(name)
// Written under export/ by their name in the zip: yauzl refuses `..`, absolute names and
// backslashes, so the name stays inside
const isWellness = (name: string) =>
  /(?:^|\/)DI-Connect-(Wellness|Aggregator|Metrics)\/.*\.json$/u.test(name)

// Activities by start second, to match FIT files: exact, else the nearest within a minute
export const matcher = (summaries: ReadonlyArray<ActivitySummary>) => {
  const byStart = new Map(summaries.map((s) => [Math.round(Date.parse(s.start_time) / 1000), s]))
  return (start: string): ActivitySummary | undefined => {
    const second = Math.round(Date.parse(start) / 1000)
    for (let delta = 0; delta <= 60; delta += 1) {
      const found = byStart.get(second - delta) ?? byStart.get(second + delta)
      if (found !== undefined) return found
    }
    return undefined
  }
}

export const importExport = (zipPath: string, dataDir: string) =>
  Effect.tryPromise({
    try: async (): Promise<ExportSummary> => {
      const exportName = basename(zipPath).replace(/\.zip$/iu, '')
      let wellnessFiles = 0

      // First the summaries (and the wellness files on the way): the FIT files are matched to them
      const summaries: Array<ActivitySummary> = []
      for await (const entry of entries(zipPath)) {
        if (isSummaries(entry.name)) {
          const json: unknown = JSON.parse((await entry.read()).toString('utf8'))
          const wrappers = Array.isArray(json) ? json : [json]
          for (const wrapper of wrappers) {
            if (!Predicate.hasProperty(wrapper, 'summarizedActivitiesExport')) continue
            const items = wrapper.summarizedActivitiesExport
            if (!Array.isArray(items)) continue
            for (const item of items) {
              const summary = exportActivity(item)
              if (summary._tag === 'None') continue
              summaries.push(summary.value)
              const { id, day } = summary.value
              await writeAtomically(
                join(
                  dataDir,
                  'connect/activities',
                  (day ?? '0000').slice(0, 4),
                  `${id}.export.json`
                ),
                JSON.stringify(item)
              )
            }
          }
        } else if (isWellness(entry.name)) {
          await writeAtomically(join(dataDir, 'export', exportName, entry.name), await entry.read())
          wellnessFiles += 1
        }
      }

      const match = matcher(summaries)
      const counts = { fitMatched: 0, fitKept: 0, fitUnmatched: 0, fitSkipped: 0 }
      const scratch = await mkdtemp(join(tmpdir(), 'garmin-export-'))
      try {
        for await (const entry of entries(zipPath)) {
          if (!isUploads(entry.name)) continue
          // An inner zip of uploads, read from disk like the outer one
          const inner = join(scratch, basename(entry.name))
          await entry.saveTo(inner)
          for await (const upload of entries(inner)) {
            if (!upload.name.toLowerCase().endsWith('.fit')) {
              counts.fitSkipped += 1
              continue
            }
            const bytes = await upload.read()
            const start = fitFileType(bytes) === 'activity' ? fitStart(bytes) : null
            if (start === null) {
              counts.fitSkipped += 1
              continue
            }
            const summary = match(start)
            if (summary === undefined) {
              await writeAtomically(join(dataDir, 'fit/unmatched', basename(upload.name)), bytes)
              counts.fitUnmatched += 1
              continue
            }
            const target = join(
              dataDir,
              'fit',
              (summary.day ?? '0000').slice(0, 4),
              `${summary.id}.fit`
            )
            if (await exists(target)) {
              counts.fitKept += 1
              continue
            }
            await writeAtomically(target, bytes)
            counts.fitMatched += 1
          }
          await rm(inner, { force: true })
        }
      } finally {
        await rm(scratch, { recursive: true, force: true })
      }
      return { summaries: summaries.length, wellnessFiles, ...counts }
    },
    catch: (error) =>
      new ExportError({ message: error instanceof Error ? error.message : String(error) }),
  })

export const describeExport = (summary: ExportSummary) =>
  [
    `${summary.summaries} activity summaries`,
    `FIT files: ${summary.fitMatched} new, ${summary.fitKept} already synced, ${summary.fitUnmatched} unmatched (fit/unmatched/), ${summary.fitSkipped} skipped (not an activity)`,
    `${summary.wellnessFiles} wellness files`,
  ].join('\n')

const backfill = Command.make(
  'backfill',
  {
    zip: Argument.File('export', { mustExist: true }).pipe(
      Argument.withDescription('The zip of Garmin\'s "Export your data"')
    ),
  },
  Effect.fn(function* ({ zip }) {
    const dataDir = yield* Config.String('DATA_DIR')
    const summary = yield* importExport(zip, dataDir)
    yield* Console.log(describeExport(summary))
    const ingested = yield* Ingest.use((ingest) => ingest.run())
    yield* Console.log(`Ingested ${describeIngest(ingested)}`)
    for (const error of ingested.errors) yield* Console.error(error)
    if (ingested.errors.length > 0) process.exitCode = 1
  })
).pipe(
  Command.withDescription(
    "Import a Garmin export zip into DATA_DIR (activities' FIT files and summaries, wellness), then ingest it"
  )
)

if (import.meta.main) {
  backfill.pipe(
    Command.run({ version: '1.0.0' }),
    Effect.provide(
      Ingest.layer.pipe(Layer.provideMerge(Database.layer), Layer.provideMerge(NodeServices.layer))
    ),
    NodeRuntime.runMain
  )
}
