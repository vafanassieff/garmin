import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { Encoder, Profile } from '@garmin/fitsdk'
import { sql, type SQL } from 'drizzle-orm'
import { ConfigProvider, Effect, Layer } from 'effect'

import { Database } from '../src/db.ts'

// Made-up data in Garmin's shapes: no real health data in the repository

// A fresh data/ and SQLite file, removed with the layer; the directory is in DATA_DIR
export const testConfig = Layer.unwrap(
  Effect.acquireRelease(
    Effect.sync(() => mkdtempSync(join(tmpdir(), 'garmin-'))),
    (directory) => Effect.sync(() => rmSync(directory, { recursive: true, force: true }))
  ).pipe(
    Effect.map((directory) =>
      ConfigProvider.layer(
        ConfigProvider.fromUnknown({
          DATA_DIR: join(directory, 'data'),
          DATABASE_PATH: join(directory, 'garmin.db'),
          GARMIN_SESSION_PATH: join(directory, 'session', 'garmin.json'),
        })
      )
    )
  )
)

export const dataDir = Effect.map(Database, ({ path }) => join(dirname(path), 'data'))

export const put = (path: string, content: Uint8Array | string | object) =>
  Effect.map(dataDir, (root) => {
    const target = join(root, path)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(
      target,
      typeof content === 'string' || content instanceof Uint8Array
        ? content
        : JSON.stringify(content)
    )
  })

export const rows = <A = Record<string, unknown>>(query: SQL) =>
  Effect.flatMap(Database, ({ use }) => use((db) => db.all<A>(query)))
export { sql }

// A message's number in the FIT profile
const mesgNum = (name: string) => {
  const value = Profile.MesgNum[name]
  if (value === undefined) throw new Error(`No FIT message ${name}`)
  return value
}

// The FIT epoch in Unix seconds
const fitEpoch = 631_065_600

// A run: one record a second at `speed` m/s, HR climbing from 130, laps of `lapSeconds`
export const fitRun = ({
  start = new Date('2026-10-31T06:12:40Z'),
  seconds = 1200,
  speed = 3,
  sport = 'running',
  lapSeconds = 600,
  utcOffset = 3600,
  type = 'activity',
}: {
  readonly start?: Date
  readonly seconds?: number
  readonly speed?: number
  readonly sport?: string
  readonly lapSeconds?: number
  readonly utcOffset?: number
  readonly type?: string
} = {}) => {
  const encoder = new Encoder()
  // The profile's fields by name, strings for its enums (the decoder's own options)
  const write = (name: string, fields: object) => encoder.onMesg(mesgNum(name), fields)
  const at = (s: number) => new Date(start.getTime() + s * 1000)
  write('FILE_ID', {
    type,
    manufacturer: 'garmin',
    product: 2157,
    garminProduct: 'fr230',
    timeCreated: start,
    serialNumber: 1,
  })
  write('WORKOUT', { wktName: 'Easy 20', sport })
  for (let s = 0; s <= seconds; s += 1) {
    write('RECORD', {
      timestamp: at(s),
      heartRate: 130 + Math.floor((s / seconds) * 20),
      cadence: 80,
      fractionalCadence: 0.5,
      distance: s * speed,
      enhancedSpeed: speed,
      enhancedAltitude: 50 + (s % 100) / 10,
      // ~0.3 m north a second
      positionLat: 582_870_012 + s * 30,
      positionLong: 27_423_366,
    })
  }
  for (let lap = 0; lap * lapSeconds < seconds; lap += 1) {
    const length = Math.min(lapSeconds, seconds - lap * lapSeconds)
    write('LAP', {
      timestamp: at(lap * lapSeconds + length),
      startTime: at(lap * lapSeconds),
      totalElapsedTime: length,
      totalTimerTime: length,
      totalDistance: length * speed,
      avgHeartRate: 140,
      maxHeartRate: 150,
      enhancedAvgSpeed: speed,
      avgCadence: 80,
      avgFractionalCadence: 0.5,
      intensity: 'active',
      lapTrigger: 'time',
      messageIndex: lap,
    })
  }
  write('SESSION', {
    timestamp: at(seconds),
    startTime: start,
    sport,
    subSport: 'generic',
    totalElapsedTime: seconds,
    totalTimerTime: seconds,
    totalDistance: seconds * speed,
    totalAscent: 12,
    totalDescent: 11,
    avgHeartRate: 140,
    maxHeartRate: 150,
    enhancedAvgSpeed: speed,
    enhancedMaxSpeed: speed + 1,
    avgCadence: 80,
    avgFractionalCadence: 0.5,
    totalCalories: 300,
    trainingLoadPeak: 80.5,
    totalTrainingEffect: 3.1,
    totalAnaerobicTrainingEffect: 0.4,
    workoutRpe: 50,
    workoutFeel: 75,
    startPositionLat: 582_870_012,
    startPositionLong: 27_423_366,
  })
  write('TIME_IN_ZONE', {
    timestamp: at(seconds),
    referenceMesg: 'session',
    referenceIndex: 0,
    timeInHrZone: [10, 20, 30, 400, 500, 240, 0],
    hrZoneHighBoundary: [100, 120, 140, 155, 170, 185],
  })
  write('ACTIVITY', {
    timestamp: at(seconds),
    localTimestamp: Math.round(at(seconds).getTime() / 1000) - fitEpoch + utcOffset,
    numSessions: 1,
    type: 'manual',
  })
  return encoder.close()
}

// The activity list's item for the run above, as the sync writes it
export const apiSummary = (id: number, overrides: Record<string, unknown> = {}) => ({
  activityId: id,
  activityName: 'Morning Run - Easy 20',
  startTimeLocal: '2026-10-31 07:12:40',
  startTimeGMT: '2026-10-31 06:12:40',
  activityType: { typeId: 1, typeKey: 'running' },
  distance: 3600,
  duration: 1200,
  elapsedDuration: 1200,
  movingDuration: 1190,
  averageHR: 140,
  activityTrainingLoad: 81.2,
  aerobicTrainingEffect: 3.1000001,
  anaerobicTrainingEffect: 0.4,
  trainingEffectLabel: 'AEROBIC_BASE',
  vO2MaxValue: 41,
  gear: [{ displayName: 'Road Shoes' }],
  ...overrides,
})

// The sync's daily file, trimmed to what the app reads
export const dailyFile = (day: string) => ({
  date: day,
  stats: {
    calendarDate: day,
    totalSteps: 8420,
    restingHeartRate: 58,
    averageStressLevel: 27,
    bodyBatteryAtWakeTime: 71,
    bodyBatteryHighestValue: 73,
    moderateIntensityMinutes: 12,
    vigorousIntensityMinutes: 35,
  },
  sleep: {
    dailySleepDTO: {
      calendarDate: day,
      sleepTimeSeconds: 26_400,
      sleepStartTimestampGMT: Date.parse(`${day}T21:10:00Z`) - 86_400_000,
      sleepEndTimestampGMT: Date.parse(`${day}T05:20:00Z`),
      deepSleepSeconds: 4200,
      lightSleepSeconds: 16_000,
      remSleepSeconds: 6200,
      awakeSleepSeconds: 300,
      sleepScores: { overall: { value: 78, qualifierKey: 'FAIR' } },
    },
    avgOvernightHrv: 52,
    hrvStatus: 'BALANCED',
    restingHeartRate: 58,
  },
  hrv: {
    hrvSummary: {
      calendarDate: day,
      lastNightAvg: 52,
      weeklyAvg: 50,
      status: 'BALANCED',
      baseline: { balancedLow: 46, balancedUpper: 57 },
    },
  },
  training_readiness: [
    {
      calendarDate: day,
      timestamp: `${day}T12:00:00.0`,
      score: 55,
      level: 'MODERATE',
      inputContext: 'UPDATE_REALTIME_VARIABLES',
      hrvFactorPercent: 100,
    },
    {
      calendarDate: day,
      timestamp: `${day}T06:16:00.0`,
      score: 88,
      level: 'HIGH',
      feedbackShort: 'READY_FOR_ACTION',
      recoveryTime: 6,
      acuteLoad: 61,
      inputContext: 'AFTER_WAKEUP_RESET',
      hrvFactorPercent: 100,
    },
  ],
  training_status: { mostRecentTrainingStatus: null },
  max_metrics: [{ generic: { calendarDate: day, vo2MaxPreciseValue: 51.3 }, cycling: null }],
  race_predictions: {
    calendarDate: day,
    time5K: 1395,
    time10K: 2905,
    timeHalfMarathon: 6440,
    timeMarathon: 13_720,
  },
})
