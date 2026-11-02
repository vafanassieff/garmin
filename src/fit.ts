import { Decoder, Stream } from '@garmin/fitsdk'
import { Effect, Predicate, Schema } from 'effect'

import { encode, simplify, type Point } from './polyline.ts'

// An activity's FIT file, decoded with Garmin's FIT SDK, into the columns of activities, laps
// and samples (see schema.ts)

export class FitError extends Schema.TaggedError<FitError>()('FitError', {
  message: Schema.String,
}) {}

export interface Lap {
  readonly idx: number
  readonly start_time: string
  readonly elapsed_s: number | null
  readonly moving_s: number | null
  readonly distance_m: number | null
  readonly avg_hr: number | null
  readonly max_hr: number | null
  readonly avg_speed: number | null
  readonly max_speed: number | null
  readonly avg_cadence: number | null
  readonly avg_power: number | null
  readonly ascent_m: number | null
  readonly descent_m: number | null
  readonly intensity: string | null
  readonly trigger: string | null
  readonly workout_step: number | null
}

export interface Sample {
  readonly t: number
  readonly lat: number | null
  readonly lon: number | null
  readonly alt: number | null
  readonly hr: number | null
  readonly speed: number | null
  readonly cadence: number | null
  readonly power: number | null
  readonly distance: number | null
}

export interface FitActivity {
  readonly fit_sport: string | null
  readonly fit_sub_sport: string | null
  readonly start_time: string
  // Local time minus UTC, from the activity message (the watch's zone)
  readonly utc_offset_s: number | null
  readonly elapsed_s: number | null
  readonly moving_s: number | null
  readonly distance_m: number | null
  readonly ascent_m: number | null
  readonly descent_m: number | null
  readonly avg_hr: number | null
  readonly max_hr: number | null
  readonly avg_speed: number | null
  readonly max_speed: number | null
  readonly avg_cadence: number | null
  readonly max_cadence: number | null
  readonly avg_power: number | null
  readonly max_power: number | null
  readonly norm_power: number | null
  readonly calories: number | null
  readonly training_load: number | null
  readonly aerobic_te: number | null
  readonly anaerobic_te: number | null
  readonly rpe: number | null
  readonly feel: number | null
  readonly hr_z1_s: number | null
  readonly hr_z2_s: number | null
  readonly hr_z3_s: number | null
  readonly hr_z4_s: number | null
  readonly hr_z5_s: number | null
  readonly hr_zone_bounds: string | null
  readonly workout_name: string | null
  readonly device: string | null
  readonly start_lat: number | null
  readonly start_lon: number | null
  readonly polyline: string | null
  readonly laps: ReadonlyArray<Lap>
  readonly samples: ReadonlyArray<Sample>
}

// The FIT epoch (1989-12-31T00:00:00Z) in Unix seconds: local timestamps count from it
const fitEpoch = 631_065_600

// Sports whose FIT cadence is strides (one foot) per minute: Garmin Connect shows steps per minute
const onFoot: ReadonlySet<string> = new Set(['running', 'walking', 'hiking'])

const num = (value: unknown): number | null =>
  Predicate.isNumber(value) && Number.isFinite(value) ? value : null
const int = (value: unknown) => {
  const n = num(value)
  return n === null ? null : Math.round(n)
}
const str = (value: unknown): string | null =>
  Predicate.isString(value) ? value : Predicate.isNumber(value) ? String(value) : null
const iso = (value: unknown): string | null =>
  value instanceof Date && !Number.isNaN(value.getTime()) ? value.toISOString() : null
const round = (value: number | null, digits: number) =>
  value === null ? null : Number(value.toFixed(digits))
// Positions are semicircles: 2^31 of them per 180°
const degrees = (value: unknown) => {
  const n = num(value)
  return n === null ? null : round((n * 180) / 2 ** 31, 6)
}
const cadence = (whole: unknown, fraction: unknown, footed: boolean) => {
  const n = num(whole)
  if (n === null) return null
  return footed ? round((n + (num(fraction) ?? 0)) * 2, 1) : n
}

// Whether the bytes are a FIT file at all, and of which kind (activity, monitoring, settings…)
export const fitFileType = (bytes: Uint8Array): string | null => {
  const decoder = new Decoder(Stream.fromByteArray(bytes))
  if (!decoder.isFIT()) return null
  const { messages } = decoder.read({ convertDateTimesToDates: true })
  return str(messages.fileIdMesgs?.[0]?.type)
}

// The activity's start (UTC ISO), to match an exported file with Garmin Connect's activity
export const fitStart = (bytes: Uint8Array): string | null => {
  const decoder = new Decoder(Stream.fromByteArray(bytes))
  if (!decoder.isFIT()) return null
  const { messages } = decoder.read({ convertDateTimesToDates: true })
  return iso(messages.sessionMesgs?.[0]?.startTime) ?? iso(messages.fileIdMesgs?.[0]?.timeCreated)
}

export const parseFit = (bytes: Uint8Array) =>
  Effect.try({
    try: () => decode(bytes),
    catch: (error) =>
      new FitError({ message: error instanceof Error ? error.message : String(error) }),
  }).pipe(
    Effect.flatMap((parsed) =>
      typeof parsed === 'string'
        ? Effect.fail(new FitError({ message: parsed }))
        : Effect.succeed(parsed)
    )
  )

// A string: why the file is not an activity
const decode = (bytes: Uint8Array): FitActivity | string => {
  const decoder = new Decoder(Stream.fromByteArray(bytes))
  if (!decoder.isFIT()) return 'not a FIT file'
  // A truncated file (a watch's crash) still decodes up to the cut: keep what is there
  const { messages, errors } = decoder.read({
    convertDateTimesToDates: true,
    mergeHeartRates: true,
  })
  const fileType = str(messages.fileIdMesgs?.[0]?.type)
  if (fileType !== 'activity') return `a FIT file of type ${fileType ?? 'unknown'}, not an activity`
  // A multisport activity has one session per leg: they are summed, the first one's sport kept
  const sessions = messages.sessionMesgs ?? []
  const session = sessions[0]
  const start = iso(session?.startTime) ?? iso(messages.recordMesgs?.[0]?.timestamp)
  if (session === undefined || start === null) {
    return errors.length > 0 ? `no session: ${errors[0]?.message ?? ''}` : 'no session'
  }
  const sum = (field: (s: (typeof sessions)[number]) => unknown) => {
    const values = sessions.map((s) => num(field(s))).filter((value) => value !== null)
    return values.length === 0 ? null : values.reduce((a, b) => a + b, 0)
  }
  const sport = str(session.sport)
  const footed = sport !== null && onFoot.has(sport)
  const startMs = Date.parse(start)

  const activity = messages.activityMesgs?.[0]
  const localTimestamp = num(activity?.localTimestamp)
  const timestamp = activity?.timestamp instanceof Date ? activity.timestamp.getTime() / 1000 : null
  const utcOffset =
    localTimestamp === null || timestamp === null
      ? null
      : Math.round((localTimestamp + fitEpoch - timestamp) / 900) * 900

  const zones = (messages.timeInZoneMesgs ?? []).find(
    (zone) => zone.referenceMesg === 'session' && zone.referenceIndex === 0
  )
  const inZone = (index: number) => round(num(zones?.timeInHrZone?.[index]), 1)
  const bounds = zones?.hrZoneHighBoundary?.filter(Predicate.isNumber)

  // One per second, the last of a second wins
  const bySecond = new Map<number, Sample>()
  for (const record of messages.recordMesgs ?? []) {
    if (!(record.timestamp instanceof Date)) continue
    const t = Math.round((record.timestamp.getTime() - startMs) / 1000)
    const lat = degrees(record.positionLat)
    const lon = degrees(record.positionLong)
    bySecond.set(t, {
      t,
      lat: lon === null ? null : lat,
      lon: lat === null ? null : lon,
      alt: round(num(record.enhancedAltitude) ?? num(record.altitude), 1),
      hr: int(record.heartRate),
      speed: round(num(record.enhancedSpeed) ?? num(record.speed), 3),
      cadence: cadence(record.cadence, record.fractionalCadence, footed),
      power: int(record.power),
      distance: round(num(record.distance), 1),
    })
  }
  const samples = [...bySecond.values()].toSorted((a, b) => a.t - b.t)
  const route = samples.flatMap((sample): Array<Point> =>
    sample.lat === null || sample.lon === null ? [] : [[sample.lat, sample.lon]]
  )

  const laps = (messages.lapMesgs ?? []).flatMap((lap, idx): Array<Lap> => {
    const lapStart = iso(lap.startTime)
    return lapStart === null
      ? []
      : [
          {
            idx,
            start_time: lapStart,
            elapsed_s: round(num(lap.totalElapsedTime), 3),
            moving_s: round(num(lap.totalTimerTime), 3),
            distance_m: round(num(lap.totalDistance), 2),
            avg_hr: int(lap.avgHeartRate),
            max_hr: int(lap.maxHeartRate),
            avg_speed: num(lap.enhancedAvgSpeed) ?? num(lap.avgSpeed),
            max_speed: num(lap.enhancedMaxSpeed) ?? num(lap.maxSpeed),
            avg_cadence: cadence(lap.avgCadence, lap.avgFractionalCadence, footed),
            avg_power: int(lap.avgPower),
            ascent_m: num(lap.totalAscent),
            descent_m: num(lap.totalDescent),
            intensity: str(lap.intensity),
            trigger: str(lap.lapTrigger),
            workout_step: int(lap.wktStepIndex),
          },
        ]
  })

  const fileId = messages.fileIdMesgs?.[0]
  const rpe = num(session.workoutRpe)
  return {
    fit_sport: sport,
    fit_sub_sport: str(session.subSport),
    start_time: start,
    utc_offset_s: utcOffset,
    elapsed_s: sum((s) => s.totalElapsedTime),
    moving_s: sum((s) => s.totalTimerTime),
    distance_m: sum((s) => s.totalDistance),
    ascent_m: sum((s) => s.totalAscent),
    descent_m: sum((s) => s.totalDescent),
    avg_hr: int(session.avgHeartRate),
    max_hr: int(session.maxHeartRate),
    avg_speed: num(session.enhancedAvgSpeed) ?? num(session.avgSpeed),
    max_speed: num(session.enhancedMaxSpeed) ?? num(session.maxSpeed),
    avg_cadence: cadence(session.avgCadence, session.avgFractionalCadence, footed),
    max_cadence: cadence(session.maxCadence, session.maxFractionalCadence, footed),
    avg_power: int(session.avgPower),
    max_power: int(session.maxPower),
    norm_power: int(session.normalizedPower),
    calories: sum((s) => s.totalCalories),
    training_load: num(session.trainingLoadPeak),
    aerobic_te: num(session.totalTrainingEffect),
    anaerobic_te: num(session.totalAnaerobicTrainingEffect),
    rpe: rpe === null ? null : rpe / 10,
    feel: int(session.workoutFeel),
    hr_z1_s: inZone(1),
    hr_z2_s: inZone(2),
    hr_z3_s: inZone(3),
    hr_z4_s: inZone(4),
    hr_z5_s: inZone(5),
    hr_zone_bounds: bounds === undefined || bounds.length === 0 ? null : JSON.stringify(bounds),
    workout_name: str(messages.workoutMesgs?.[0]?.wktName),
    device: str(fileId?.garminProduct) ?? str(fileId?.product),
    start_lat: degrees(session.startPositionLat) ?? route[0]?.[0] ?? null,
    start_lon: degrees(session.startPositionLong) ?? route[0]?.[1] ?? null,
    polyline: route.length < 2 ? null : encode(simplify(route)),
    laps,
    samples,
  }
}
