import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, it } from '@effect/vitest'
import { Effect } from 'effect'
import yazl from 'yazl'

import { fitRun } from '../test/fixtures.ts'

import { importExport } from './export.ts'

const zip = (entries: Record<string, Uint8Array | string>) =>
  new Promise<Buffer>((resolve, reject) => {
    const file = new yazl.ZipFile()
    for (const [name, content] of Object.entries(entries)) {
      file.addBuffer(Buffer.from(content), name)
    }
    const chunks: Array<Buffer> = []
    file.outputStream.on('data', (chunk: Buffer) => chunks.push(chunk))
    file.outputStream.on('error', reject)
    file.outputStream.on('end', () => resolve(Buffer.concat(chunks)))
    file.end()
  })

it.effect('matches FIT files to activities by start, keeps the rest apart', () =>
  Effect.gen(function* () {
    const directory = mkdtempSync(join(tmpdir(), 'garmin-export-test-'))
    try {
      const start = new Date('2025-05-04T06:00:00Z')
      const uploads = yield* Effect.promise(() =>
        zip({
          'user_111.fit': fitRun({ start: new Date(start.getTime() + 1000) }),
          'user_112.fit': fitRun({ start: new Date('2025-05-05T06:00:00Z') }),
          'user_113.fit': fitRun({ type: 'settings' }),
          'user_114.gpx': '<gpx/>',
        })
      )
      const summaries = [
        {
          summarizedActivitiesExport: [
            {
              activityId: 9001,
              name: 'Morning Run',
              activityType: 'running',
              startTimeGmt: start.getTime(),
              startTimeLocal: start.getTime() + 7_200_000,
              activityTrainingLoad: 90,
            },
          ],
        },
      ]
      const archive = join(directory, 'export.zip')
      writeFileSync(
        archive,
        yield* Effect.promise(() =>
          zip({
            'DI_CONNECT/DI-Connect-Fitness/user@example.com_0_summarizedActivities.json':
              JSON.stringify(summaries),
            'DI_CONNECT/DI-Connect-Uploaded-Files/UploadedFiles_0-_Part1.zip': uploads,
            'DI_CONNECT/DI-Connect-Wellness/1_sleepData.json': '[]',
            'DI_CONNECT/DI-Connect-User/user_profile.json': '{}',
          })
        )
      )
      const data = join(directory, 'data')
      const summary = yield* importExport(archive, data)
      expect(summary).toEqual({
        summaries: 1,
        fitMatched: 1,
        fitKept: 0,
        fitUnmatched: 1,
        fitSkipped: 2,
        wellnessFiles: 1,
      })
      expect(existsSync(join(data, 'fit/2025/9001.fit'))).toBe(true)
      expect(existsSync(join(data, 'connect/activities/2025/9001.export.json'))).toBe(true)
      expect(readdirSync(join(data, 'fit/unmatched'))).toEqual(['user_112.fit'])
      expect(
        existsSync(join(data, 'export/export/DI_CONNECT/DI-Connect-Wellness/1_sleepData.json'))
      ).toBe(true)
      expect(existsSync(join(data, 'export/export/DI_CONNECT/DI-Connect-User'))).toBe(false)

      // Again: the synced file stays
      expect(yield* importExport(archive, data)).toMatchObject({ fitMatched: 0, fitKept: 1 })
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
)
