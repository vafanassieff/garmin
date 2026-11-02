import { Option, Predicate, Schema } from 'effect'

import type { activities, body, daily, plannedWorkouts } from './schema.ts'

// Garmin Connect's JSON (the sync's files, see garmin/sync.ts) and the "Export your data"
// zip's, into rows. Both use the same names for most fields (the export dumps the same DTOs), with
// other units in the export's activity summaries. Every field is optional: Garmin leaves out what
// a day or a device does not have.

export type ActivitySummary = Partial<Omit<typeof activities.$inferInsert, 'id'>> & {
  readonly id: number
  readonly sport: string
  readonly start_time: string
  readonly start_local: string
}
export type DailyRow = Partial<typeof daily.$inferInsert> & { readonly day: string }
export type BodyRow = typeof body.$inferInsert
export type PlannedWorkout = typeof plannedWorkouts.$inferInsert

const Num = Schema.optional(Schema.NullOr(Schema.Number))
const Str = Schema.optional(Schema.NullOr(Schema.String))
// Epoch milliseconds, or Garmin's "YYYY-MM-DD HH:MM:SS(.f)" / "YYYY-MM-DDTHH:MM:SS(.f)"
const Instant = Schema.optional(Schema.NullOr(Schema.Union([Schema.Number, Schema.String])))

const nullable = <A>(value: A | null | undefined): A | null => value ?? null
const positive = (value: number | null | undefined) =>
  value === null || value === undefined || value <= 0 ? null : value
const round = (value: number | null | undefined, digits = 0) =>
  value === null || value === undefined ? null : Number(value.toFixed(digits))

// A UTC instant as ISO 8601 (Garmin's strings without a zone are UTC when they say GMT)
export const utcIso = (value: number | string | null | undefined): string | null => {
  if (value === null || value === undefined) return null
  const date = Predicate.isNumber(value)
    ? new Date(value)
    : new Date(`${value.replace(' ', 'T').replace(/Z$/u, '')}Z`)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}
// A local wall time as YYYY-MM-DDTHH:MM:SS: Garmin's local epochs are the wall time read as UTC
export const localIso = (value: number | string | null | undefined): string | null =>
  utcIso(value)?.slice(0, 19) ?? null

const Gear = Schema.Struct({ displayName: Str, customMakeModel: Str })

// The activity list's items, plus the sync's `gear` (filterGear)
const ApiActivity = Schema.Struct({
  activityId: Schema.Number,
  activityName: Str,
  startTimeGMT: Schema.String,
  startTimeLocal: Schema.String,
  activityType: Schema.Struct({ typeKey: Schema.String }),
  distance: Num,
  duration: Num,
  elapsedDuration: Num,
  movingDuration: Num,
  elevationGain: Num,
  elevationLoss: Num,
  averageHR: Num,
  maxHR: Num,
  averageSpeed: Num,
  maxSpeed: Num,
  averageRunningCadenceInStepsPerMinute: Num,
  maxRunningCadenceInStepsPerMinute: Num,
  averageBikingCadenceInRevPerMinute: Num,
  maxBikingCadenceInRevPerMinute: Num,
  avgPower: Num,
  maxPower: Num,
  normPower: Num,
  calories: Num,
  activityTrainingLoad: Num,
  aerobicTrainingEffect: Num,
  anaerobicTrainingEffect: Num,
  trainingEffectLabel: Str,
  vO2MaxValue: Num,
  hrTimeInZone_1: Num,
  hrTimeInZone_2: Num,
  hrTimeInZone_3: Num,
  hrTimeInZone_4: Num,
  hrTimeInZone_5: Num,
  startLatitude: Num,
  startLongitude: Num,
  gear: Schema.optional(Schema.NullOr(Schema.Array(Gear))),
})

// The export's summarizedActivities items: milliseconds, centimetres, speeds in cm/ms (×10 for
// m/s), the type as a plain key. Only what FIT files do not hold is trusted (a FIT file's values
// win, see ingest.ts); its physical values only stand in for an activity without one.
const ExportActivity = Schema.Struct({
  activityId: Schema.Number,
  name: Str,
  activityType: Schema.String,
  startTimeGmt: Schema.Number,
  startTimeLocal: Schema.Number,
  duration: Num,
  elapsedDuration: Num,
  movingDuration: Num,
  distance: Num,
  elevationGain: Num,
  elevationLoss: Num,
  avgHr: Num,
  maxHr: Num,
  avgSpeed: Num,
  maxSpeed: Num,
  avgPower: Num,
  maxPower: Num,
  normPower: Num,
  activityTrainingLoad: Num,
  aerobicTrainingEffect: Num,
  anaerobicTrainingEffect: Num,
  trainingEffectLabel: Str,
  vO2MaxValue: Num,
  startLatitude: Num,
  startLongitude: Num,
})

const gearNames = (gear: ReadonlyArray<typeof Gear.Type> | null | undefined) =>
  gear
    ?.map((item) => item.displayName ?? item.customMakeModel)
    .filter((name) => Predicate.isString(name))
    .join(', ') ?? null

export const apiActivity = (json: unknown): Option.Option<ActivitySummary> =>
  Schema.decodeUnknownOption(ApiActivity)(json).pipe(
    Option.flatMap((a): Option.Option<ActivitySummary> => {
      const startTime = utcIso(a.startTimeGMT)
      const startLocal = localIso(a.startTimeLocal)
      if (startTime === null || startLocal === null) return Option.none()
      return Option.some({
        id: a.activityId,
        name: nullable(a.activityName),
        sport: a.activityType.typeKey,
        start_time: startTime,
        start_local: startLocal,
        day: startLocal.slice(0, 10),
        elapsed_s: nullable(a.elapsedDuration ?? a.duration),
        moving_s: nullable(a.movingDuration),
        distance_m: nullable(a.distance),
        ascent_m: nullable(a.elevationGain),
        descent_m: nullable(a.elevationLoss),
        avg_hr: round(a.averageHR),
        max_hr: round(a.maxHR),
        avg_speed: nullable(a.averageSpeed),
        max_speed: nullable(a.maxSpeed),
        avg_cadence: round(
          a.averageRunningCadenceInStepsPerMinute ?? a.averageBikingCadenceInRevPerMinute,
          1
        ),
        max_cadence: round(
          a.maxRunningCadenceInStepsPerMinute ?? a.maxBikingCadenceInRevPerMinute,
          1
        ),
        avg_power: round(a.avgPower),
        max_power: round(a.maxPower),
        norm_power: round(a.normPower),
        calories: round(a.calories),
        training_load: nullable(a.activityTrainingLoad),
        aerobic_te: round(a.aerobicTrainingEffect, 1),
        anaerobic_te: round(a.anaerobicTrainingEffect, 1),
        te_label: nullable(a.trainingEffectLabel),
        vo2max: nullable(a.vO2MaxValue),
        hr_z1_s: nullable(a.hrTimeInZone_1),
        hr_z2_s: nullable(a.hrTimeInZone_2),
        hr_z3_s: nullable(a.hrTimeInZone_3),
        hr_z4_s: nullable(a.hrTimeInZone_4),
        hr_z5_s: nullable(a.hrTimeInZone_5),
        gear: gearNames(a.gear),
        start_lat: nullable(a.startLatitude),
        start_lon: nullable(a.startLongitude),
      })
    })
  )

const ms = (value: number | null | undefined) =>
  value === null || value === undefined ? null : value / 1000
const cm = (value: number | null | undefined) =>
  value === null || value === undefined ? null : value / 100

export const exportActivity = (json: unknown): Option.Option<ActivitySummary> =>
  Schema.decodeUnknownOption(ExportActivity)(json).pipe(
    Option.flatMap((a): Option.Option<ActivitySummary> => {
      const startTime = utcIso(a.startTimeGmt)
      const startLocal = localIso(a.startTimeLocal)
      if (startTime === null || startLocal === null) return Option.none()
      return Option.some({
        id: a.activityId,
        name: nullable(a.name),
        sport: a.activityType,
        start_time: startTime,
        start_local: startLocal,
        day: startLocal.slice(0, 10),
        elapsed_s: ms(a.elapsedDuration ?? a.duration),
        moving_s: ms(a.movingDuration),
        distance_m: cm(a.distance),
        ascent_m: cm(a.elevationGain),
        descent_m: cm(a.elevationLoss),
        avg_hr: round(a.avgHr),
        max_hr: round(a.maxHr),
        avg_speed: a.avgSpeed === null || a.avgSpeed === undefined ? null : a.avgSpeed * 10,
        max_speed: a.maxSpeed === null || a.maxSpeed === undefined ? null : a.maxSpeed * 10,
        avg_power: round(a.avgPower),
        max_power: round(a.maxPower),
        norm_power: round(a.normPower),
        training_load: nullable(a.activityTrainingLoad),
        aerobic_te: round(a.aerobicTrainingEffect, 1),
        anaerobic_te: round(a.anaerobicTrainingEffect, 1),
        te_label: nullable(a.trainingEffectLabel),
        vo2max: nullable(a.vO2MaxValue),
        start_lat: nullable(a.startLatitude),
        start_lon: nullable(a.startLongitude),
      })
    })
  )

// The export's activity summaries file: [{ summarizedActivitiesExport: [...] }]
export const exportActivities = (json: unknown): Array<ActivitySummary> =>
  (Predicate.isIterable(json) && !Predicate.isString(json) ? [...json] : [json]).flatMap(
    (wrapper) =>
      Predicate.hasProperty(wrapper, 'summarizedActivitiesExport') &&
      Array.isArray(wrapper.summarizedActivitiesExport)
        ? wrapper.summarizedActivitiesExport.flatMap((item) => Option.toArray(exportActivity(item)))
        : []
  )

// --- Days. One mapper per kind of record; a record of the export goes through every mapper that
// decodes it, the API's daily file through the one of each of its parts.

const CalendarDate = Schema.Union([Schema.String, Schema.Struct({ date: Schema.String })])
const dayOf = (value: typeof CalendarDate.Type | null | undefined) => {
  const text = Predicate.isString(value) ? value : value?.date
  return text !== undefined && /^\d{4}-\d{2}-\d{2}/u.test(text) ? text.slice(0, 10) : null
}

// get_stats (the API) and the export's UDS files (the same user daily summary, stress and body
// battery nested)
const Stats = Schema.Struct({
  calendarDate: CalendarDate,
  totalSteps: Num,
  totalDistanceMeters: Num,
  activeKilocalories: Num,
  totalKilocalories: Num,
  restingHeartRate: Num,
  minHeartRate: Num,
  maxHeartRate: Num,
  averageStressLevel: Num,
  maxStressLevel: Num,
  moderateIntensityMinutes: Num,
  vigorousIntensityMinutes: Num,
  bodyBatteryHighestValue: Num,
  bodyBatteryLowestValue: Num,
  bodyBatteryAtWakeTime: Num,
  bodyBatteryChargedValue: Num,
  bodyBatteryDrainedValue: Num,
  avgWakingRespirationValue: Num,
  averageSpo2: Num,
  allDayStress: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        aggregatorList: Schema.optional(
          Schema.Array(Schema.Struct({ type: Str, averageStressLevel: Num, maxStressLevel: Num }))
        ),
      })
    )
  ),
  bodyBattery: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        chargedValue: Num,
        drainedValue: Num,
        bodyBatteryStatList: Schema.optional(
          Schema.Array(Schema.Struct({ bodyBatteryStatType: Str, statsValue: Num }))
        ),
      })
    )
  ),
  respiration: Schema.optional(Schema.NullOr(Schema.Struct({ avgWakingRespirationValue: Num }))),
})

const statsRow = (s: typeof Stats.Type, day: string): DailyRow => {
  const stress = s.allDayStress?.aggregatorList?.find((item) => item.type === 'TOTAL')
  const battery = (type: string) =>
    s.bodyBattery?.bodyBatteryStatList?.find((item) => item.bodyBatteryStatType === type)
      ?.statsValue
  return {
    day,
    steps: nullable(s.totalSteps),
    distance_m: nullable(s.totalDistanceMeters),
    active_kcal: round(s.activeKilocalories),
    total_kcal: round(s.totalKilocalories),
    resting_hr: positive(s.restingHeartRate),
    min_hr: positive(s.minHeartRate),
    max_hr: positive(s.maxHeartRate),
    // -1 / -2: not enough data
    stress_avg: positive(s.averageStressLevel ?? stress?.averageStressLevel),
    stress_max: positive(s.maxStressLevel ?? stress?.maxStressLevel),
    intensity_moderate_min: nullable(s.moderateIntensityMinutes),
    intensity_vigorous_min: nullable(s.vigorousIntensityMinutes),
    body_battery_high: nullable(s.bodyBatteryHighestValue ?? battery('HIGHEST')),
    body_battery_low: nullable(s.bodyBatteryLowestValue ?? battery('LOWEST')),
    body_battery_wake: nullable(s.bodyBatteryAtWakeTime ?? battery('WAKEUP')),
    body_battery_charged: nullable(s.bodyBatteryChargedValue ?? s.bodyBattery?.chargedValue),
    body_battery_drained: nullable(s.bodyBatteryDrainedValue ?? s.bodyBattery?.drainedValue),
    respiration_avg: positive(
      s.avgWakingRespirationValue ?? s.respiration?.avgWakingRespirationValue
    ),
    spo2_avg: positive(s.averageSpo2),
  }
}

// get_sleep_data's dailySleepDTO, and the export's sleepData records
const Sleep = Schema.Struct({
  calendarDate: CalendarDate,
  sleepStartTimestampGMT: Instant,
  sleepEndTimestampGMT: Instant,
  sleepTimeSeconds: Num,
  deepSleepSeconds: Num,
  lightSleepSeconds: Num,
  remSleepSeconds: Num,
  awakeSleepSeconds: Num,
  napTimeSeconds: Num,
  sleepScores: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        overall: Schema.optional(Schema.NullOr(Schema.Struct({ value: Num }))),
        overallScore: Num,
      })
    )
  ),
})

const sleepRow = (s: typeof Sleep.Type, day: string): DailyRow => {
  const stages = [s.deepSleepSeconds, s.lightSleepSeconds, s.remSleepSeconds]
  const staged = stages.every((stage) => Predicate.isNumber(stage))
    ? stages.reduce<number>((total, value) => total + value, 0)
    : null
  return {
    day,
    sleep_start: utcIso(s.sleepStartTimestampGMT),
    sleep_end: utcIso(s.sleepEndTimestampGMT),
    sleep_s: positive(s.sleepTimeSeconds ?? staged),
    deep_s: nullable(s.deepSleepSeconds),
    light_s: nullable(s.lightSleepSeconds),
    rem_s: nullable(s.remSleepSeconds),
    awake_s: nullable(s.awakeSleepSeconds),
    nap_s: nullable(s.napTimeSeconds),
    sleep_score: nullable(s.sleepScores?.overall?.value ?? s.sleepScores?.overallScore),
  }
}

// get_hrv_data's hrvSummary
const Hrv = Schema.Struct({
  calendarDate: CalendarDate,
  lastNightAvg: Num,
  weeklyAvg: Num,
  status: Str,
  baseline: Schema.optional(Schema.NullOr(Schema.Struct({ balancedLow: Num, balancedUpper: Num }))),
})

const hrvRow = (h: typeof Hrv.Type, day: string): DailyRow => ({
  day,
  hrv: positive(h.lastNightAvg),
  hrv_weekly: positive(h.weeklyAvg),
  hrv_status: nullable(h.status),
  hrv_baseline_low: nullable(h.baseline?.balancedLow),
  hrv_baseline_high: nullable(h.baseline?.balancedUpper),
})

// get_training_readiness's items (several a day: the morning's is kept, see readinessOfDay)
const Readiness = Schema.Struct({
  calendarDate: CalendarDate,
  timestamp: Instant,
  score: Schema.Number,
  level: Str,
  feedbackShort: Str,
  recoveryTime: Num,
  acuteLoad: Num,
  inputContext: Str,
  hrvFactorPercent: Num,
})
type ReadinessRecord = typeof Readiness.Type

const readinessRow = (r: ReadinessRecord, day: string): DailyRow => ({
  day,
  readiness: r.score,
  readiness_level: nullable(r.level),
  readiness_feedback: nullable(r.feedbackShort),
  recovery_time_h: nullable(r.recoveryTime),
  acute_load: nullable(r.acuteLoad),
})

// The first after waking up, else the day's first
const readinessOfDay = (records: ReadonlyArray<ReadinessRecord>) => {
  const sorted = records.toSorted((a, b) =>
    (utcIso(a.timestamp) ?? '').localeCompare(utcIso(b.timestamp) ?? '')
  )
  return sorted.find((r) => r.inputContext === 'AFTER_WAKEUP_RESET') ?? sorted[0]
}

// get_max_metrics' items ({ generic, cycling }), and the export's MaxMet records
const VO2 = Schema.Struct({ calendarDate: CalendarDate, vo2MaxPreciseValue: Num, vo2MaxValue: Num })
const MaxMetrics = Schema.Struct({
  generic: Schema.optional(Schema.NullOr(VO2)),
  cycling: Schema.optional(Schema.NullOr(VO2)),
})
const ExportMaxMet = Schema.Struct({
  calendarDate: CalendarDate,
  vo2MaxValue: Schema.Number,
  sport: Str,
})

// get_race_predictions' daily items, and the export's RunRacePredictions records
const RacePredictions = Schema.Struct({
  calendarDate: CalendarDate,
  time5K: Num,
  time10K: Num,
  timeHalfMarathon: Num,
  timeMarathon: Num,
  raceTime5K: Num,
  raceTime10K: Num,
  raceTimeHalf: Num,
  raceTimeMarathon: Num,
})

const raceRow = (r: typeof RacePredictions.Type, day: string): DailyRow => ({
  day,
  race_5k_s: round(r.time5K ?? r.raceTime5K),
  race_10k_s: round(r.time10K ?? r.raceTime10K),
  race_half_s: round(r.timeHalfMarathon ?? r.raceTimeHalf),
  race_marathon_s: round(r.timeMarathon ?? r.raceTimeMarathon),
})

// get_training_status: its latest status by device, kept only when it is this day's
const TrainingStatus = Schema.Struct({
  mostRecentTrainingStatus: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        latestTrainingStatusData: Schema.optional(
          Schema.NullOr(
            Schema.Record(
              Schema.String,
              Schema.Struct({
                calendarDate: Str,
                primaryTrainingDevice: Schema.optional(Schema.NullOr(Schema.Boolean)),
                trainingStatusFeedbackPhrase: Str,
                acuteTrainingLoadDTO: Schema.optional(
                  Schema.NullOr(
                    Schema.Struct({ dailyTrainingLoadAcute: Num, dailyTrainingLoadChronic: Num })
                  )
                ),
              })
            )
          )
        ),
      })
    )
  ),
})

const statusRow = (s: typeof TrainingStatus.Type, day: string): DailyRow | null => {
  const devices = Object.values(s.mostRecentTrainingStatus?.latestTrainingStatusData ?? {})
  const status = devices.find((d) => d.primaryTrainingDevice === true) ?? devices[0]
  if (status?.calendarDate !== day) return null
  return {
    day,
    training_status: nullable(status.trainingStatusFeedbackPhrase),
    chronic_load: positive(status.acuteTrainingLoadDTO?.dailyTrainingLoadChronic),
  }
}

// Fields set by later rows win, nulls never erase
export const mergeDaily = (rows: ReadonlyArray<DailyRow | null>): DailyRow | null => {
  let merged: Record<string, unknown> | null = null
  for (const row of rows) {
    if (row === null) continue
    merged ??= { day: row.day }
    for (const [key, value] of Object.entries(row)) {
      if (Predicate.isNotNullish(value)) merged[key] = value
    }
  }
  return merged as DailyRow | null
}

const decode =
  <S extends Schema.Codec<unknown, unknown>>(schema: S) =>
  (json: unknown) =>
    Option.getOrNull(Schema.decodeUnknownOption(schema)(json))

// The sync's connect/daily/YYYY/<date>.json
const DailyFile = Schema.Struct({
  date: Schema.String,
  stats: Schema.optional(Schema.Unknown),
  sleep: Schema.optional(Schema.Unknown),
  hrv: Schema.optional(Schema.Unknown),
  training_readiness: Schema.optional(Schema.Unknown),
  training_status: Schema.optional(Schema.Unknown),
  max_metrics: Schema.optional(Schema.Unknown),
  race_predictions: Schema.optional(Schema.Unknown),
})
const SleepFile = Schema.Struct({
  dailySleepDTO: Schema.optional(Schema.NullOr(Schema.Unknown)),
  avgOvernightHrv: Num,
  hrvStatus: Str,
  restingHeartRate: Num,
})
const HrvFile = Schema.Struct({ hrvSummary: Schema.optional(Schema.NullOr(Schema.Unknown)) })

export const apiDaily = (json: unknown): DailyRow | null => {
  const file = decode(DailyFile)(json)
  if (file === null) return null
  const { date: day } = file
  const stats = decode(Stats)(file.stats)
  const sleepFile = decode(SleepFile)(file.sleep)
  const sleep = decode(Sleep)(sleepFile?.dailySleepDTO)
  const hrv = decode(Hrv)(decode(HrvFile)(file.hrv)?.hrvSummary)
  const readiness = readinessOfDay(
    Array.isArray(file.training_readiness)
      ? file.training_readiness.flatMap((item) => Option.toArray(decodeOption(Readiness, item)))
      : []
  )
  const maxMetrics = Array.isArray(file.max_metrics)
    ? file.max_metrics.map((item) => decode(MaxMetrics)(item)).find((item) => item !== null)
    : null
  const races = decode(RacePredictions)(file.race_predictions)
  const status = decode(TrainingStatus)(file.training_status)
  return mergeDaily([
    { day },
    stats === null ? null : statsRow(stats, day),
    sleep === null ? null : sleepRow(sleep, day),
    sleepFile === null
      ? null
      : {
          day,
          hrv: positive(sleepFile.avgOvernightHrv),
          hrv_status: nullable(sleepFile.hrvStatus),
          resting_hr: positive(sleepFile.restingHeartRate),
        },
    hrv === null ? null : hrvRow(hrv, day),
    readiness === undefined ? null : readinessRow(readiness, day),
    {
      day,
      vo2max: nullable(maxMetrics?.generic?.vo2MaxPreciseValue ?? maxMetrics?.generic?.vo2MaxValue),
      vo2max_cycling: nullable(
        maxMetrics?.cycling?.vo2MaxPreciseValue ?? maxMetrics?.cycling?.vo2MaxValue
      ),
    },
    races === null ? null : raceRow(races, day),
    status === null ? null : statusRow(status, day),
  ])
}

const decodeOption = <S extends Schema.Codec<unknown, unknown>>(schema: S, json: unknown) =>
  Schema.decodeUnknownOption(schema)(json)

// Every object with a calendarDate, wherever it is in the export's file (arrays, wrappers)
const records = (json: unknown): Array<Record<string, unknown>> => {
  if (Array.isArray(json)) return json.flatMap((item) => records(item))
  if (!Predicate.isObject(json) || Array.isArray(json)) return []
  if ('calendarDate' in json) return [json]
  return Object.values(json).flatMap((item) => records(item))
}

// The export's wellness files (UDS, sleep, HRV, readiness, max metrics, race predictions), as
// rows by day
export const exportDaily = (json: unknown): Array<DailyRow> => {
  const byDay = new Map<string, Array<DailyRow | null>>()
  const readiness = new Map<string, Array<ReadinessRecord>>()
  for (const record of records(json)) {
    const day = dayOf(decode(Schema.Struct({ calendarDate: CalendarDate }))(record)?.calendarDate)
    if (day === null) continue
    const rows = byDay.get(day) ?? []
    byDay.set(day, rows)
    const stats = decode(Stats)(record)
    if (stats !== null && ('totalSteps' in record || 'restingHeartRate' in record)) {
      rows.push(statsRow(stats, day))
    }
    const sleep = decode(Sleep)(record)
    if (sleep !== null && 'sleepStartTimestampGMT' in record) rows.push(sleepRow(sleep, day))
    const hrv = decode(Hrv)(record)
    if (hrv !== null && 'lastNightAvg' in record) rows.push(hrvRow(hrv, day))
    const ready = decode(Readiness)(record)
    if (ready !== null && 'hrvFactorPercent' in record) {
      readiness.set(day, [...(readiness.get(day) ?? []), ready])
    }
    const maxMet = decode(ExportMaxMet)(record)
    if (maxMet !== null) {
      rows.push(
        maxMet.sport?.toUpperCase() === 'CYCLING'
          ? { day, vo2max_cycling: maxMet.vo2MaxValue }
          : { day, vo2max: maxMet.vo2MaxValue }
      )
    }
    const races = decode(RacePredictions)(record)
    if (races !== null && ('raceTime5K' in record || 'time5K' in record)) {
      rows.push(raceRow(races, day))
    }
  }
  for (const [day, items] of readiness) {
    const morning = readinessOfDay(items)
    if (morning !== undefined) byDay.get(day)?.push(readinessRow(morning, day))
  }
  return [...byDay.values()].map((items) => mergeDaily(items)).filter((row) => row !== null)
}

// --- Weigh-ins: get_body_composition's month (grams, zeros for what the scale does not measure),
// the export's biometrics

const WeightRecord = Schema.Struct({
  samplePk: Num,
  timestampGMT: Instant,
  date: Instant,
  calendarDate: Schema.optional(Schema.NullOr(CalendarDate)),
  weight: Schema.Number,
  bmi: Num,
  bodyFat: Num,
  bodyWater: Num,
  boneMass: Num,
  muscleMass: Num,
  visceralFat: Num,
  sourceType: Str,
  metaData: Schema.optional(
    Schema.NullOr(Schema.Struct({ calendarDate: Schema.optional(Schema.NullOr(CalendarDate)) }))
  ),
})

// Grams in the API, kilograms or grams in the export
const kg = (value: number | null | undefined) => {
  const n = positive(value)
  return n === null ? null : round(n > 1000 ? n / 1000 : n, 2)
}

const bodyRow = (w: typeof WeightRecord.Type): BodyRow | null => {
  const day = dayOf(w.calendarDate ?? w.metaData?.calendarDate)
  const time = utcIso(w.timestampGMT) ?? (day === null ? null : `${day}T00:00:00.000Z`)
  if (day === null || time === null) return null
  return {
    time,
    day,
    weight_kg: kg(w.weight),
    bmi: positive(w.bmi),
    body_fat_pct: positive(w.bodyFat),
    body_water_pct: positive(w.bodyWater),
    muscle_mass_kg: kg(w.muscleMass),
    bone_mass_kg: kg(w.boneMass),
    visceral_fat: positive(w.visceralFat),
    source: nullable(w.sourceType),
  }
}

const BodyFile = Schema.Struct({
  startDate: Schema.String,
  endDate: Schema.String,
  dateWeightList: Schema.Array(Schema.Unknown),
})

// The month's weigh-ins and its days: the rows of those days are replaced (one deleted in
// Garmin Connect goes away)
export const apiBody = (json: unknown) => {
  const file = decode(BodyFile)(json)
  return file === null
    ? null
    : {
        start: file.startDate,
        end: file.endDate,
        rows: file.dateWeightList.flatMap((item) => {
          const weight = decode(WeightRecord)(item)
          const row = weight === null ? null : bodyRow(weight)
          return row === null ? [] : [row]
        }),
      }
}

export const exportBody = (json: unknown): Array<BodyRow> => {
  const found: Array<BodyRow> = []
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item)
      return
    }
    if (!Predicate.isObject(value)) return
    const weight = 'weight' in value ? decode(WeightRecord)(value) : null
    const row = weight === null ? null : bodyRow(weight)
    if (row === null) {
      for (const item of Object.values(value)) visit(item)
    } else {
      found.push(row)
    }
  }
  visit(json)
  return found
}

// --- The calendar's workouts, and their steps in one readable line each

// One item at a time: naps, weigh-ins and activities share the list with other shapes
const Calendar = Schema.Struct({ calendarItems: Schema.Array(Schema.Unknown) })
const CalendarWorkout = Schema.Struct({
  id: Schema.Number,
  itemType: Schema.Literal('workout'),
  title: Str,
  date: Schema.String,
  workoutId: Num,
  sportTypeKey: Str,
})

const Target = Schema.optional(Schema.NullOr(Schema.Struct({ workoutTargetTypeKey: Str })))
interface Step {
  readonly type?: string | null | undefined
  readonly stepType?: { readonly stepTypeKey?: string | null | undefined } | null | undefined
  readonly endCondition?:
    | { readonly conditionTypeKey?: string | null | undefined }
    | null
    | undefined
  readonly endConditionValue?: number | null | undefined
  readonly targetType?: typeof Target.Type
  readonly targetValueOne?: number | null | undefined
  readonly targetValueTwo?: number | null | undefined
  readonly zoneNumber?: number | null | undefined
  readonly description?: string | null | undefined
  readonly exerciseName?: string | null | undefined
  readonly numberOfIterations?: number | null | undefined
  readonly workoutSteps?: ReadonlyArray<Step> | null | undefined
}
const StepSchema: Schema.Codec<Step> = Schema.Struct({
  type: Str,
  stepType: Schema.optional(Schema.NullOr(Schema.Struct({ stepTypeKey: Str }))),
  endCondition: Schema.optional(Schema.NullOr(Schema.Struct({ conditionTypeKey: Str }))),
  endConditionValue: Num,
  targetType: Target,
  targetValueOne: Num,
  targetValueTwo: Num,
  zoneNumber: Num,
  description: Str,
  exerciseName: Str,
  numberOfIterations: Num,
  workoutSteps: Schema.optional(
    Schema.NullOr(Schema.Array(Schema.suspend((): Schema.Codec<Step> => StepSchema)))
  ),
})

const Workout = Schema.Struct({
  workoutId: Schema.Union([Schema.Number, Schema.String]),
  workoutName: Str,
  description: Str,
  sportType: Schema.optional(Schema.NullOr(Schema.Struct({ sportTypeKey: Str }))),
  estimatedDurationInSecs: Num,
  estimatedDistanceInMeters: Num,
  workoutSegments: Schema.optional(
    Schema.NullOr(Schema.Array(Schema.Struct({ workoutSteps: Schema.Array(StepSchema) })))
  ),
})

const clock = (seconds: number) => {
  const whole = Math.round(seconds)
  const h = Math.floor(whole / 3600)
  const m = Math.floor((whole % 3600) / 60)
  const s = String(whole % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`
}
// m/s → min/km
const pace = (speed: number) => `${clock(1000 / speed)}/km`

const describeStep = (step: Step): string => {
  if (step.type === 'RepeatGroupDTO' || step.stepType?.stepTypeKey === 'repeat') {
    const inner = (step.workoutSteps ?? []).map((inner) => describeStep(inner)).join(', ')
    return `${step.numberOfIterations ?? '?'}× [${inner}]`
  }
  const kind = step.stepType?.stepTypeKey ?? 'step'
  const value = step.endConditionValue
  const end =
    value === null || value === undefined
      ? 'lap button'
      : step.endCondition?.conditionTypeKey === 'time'
        ? clock(value)
        : step.endCondition?.conditionTypeKey === 'distance'
          ? value >= 1000
            ? `${value / 1000} km`
            : `${value} m`
          : step.endCondition?.conditionTypeKey === 'reps'
            ? `${value} reps`
            : 'lap button'
  const { targetValueOne: one, targetValueTwo: two } = step
  const targetKey = step.targetType?.workoutTargetTypeKey
  const target =
    targetKey === 'heart.rate.zone'
      ? one !== null && one !== undefined && two !== null && two !== undefined
        ? ` HR ${Math.round(one)}-${Math.round(two)}`
        : ` HR zone ${step.zoneNumber ?? '?'}`
      : targetKey === 'pace.zone' && one && two
        ? ` pace ${pace(two)}-${pace(one)}`
        : ''
  const exercise = step.exerciseName ? ` ${step.exerciseName}` : ''
  const note = step.description ? ` (${step.description})` : ''
  return `${kind}${exercise} ${end}${target}${note}`
}

export const workoutSteps = (json: unknown) => {
  const workout = decode(Workout)(json)
  return workout === null
    ? null
    : {
        description: nullable(workout.description),
        sport: nullable(workout.sportType?.sportTypeKey),
        estimated_duration_s: positive(workout.estimatedDurationInSecs),
        estimated_distance_m: positive(workout.estimatedDistanceInMeters),
        steps:
          (workout.workoutSegments ?? [])
            .flatMap((segment) => segment.workoutSteps.map(describeStep))
            .join('\n') || null,
      }
}

// The month's scheduled workouts, with their steps from the workout files
export const plannedFromCalendar = (
  json: unknown,
  workout: (id: number) => unknown
): Array<PlannedWorkout> => {
  const calendar = decode(Calendar)(json)
  return (calendar?.calendarItems ?? []).flatMap((raw): Array<PlannedWorkout> => {
    const item = decode(CalendarWorkout)(raw)
    if (item === null) return []
    const workoutId = nullable(item.workoutId)
    const details = workoutId === null ? null : workoutSteps(workout(workoutId))
    return [
      {
        id: item.id,
        day: item.date.slice(0, 10),
        workout_id: workoutId,
        name: item.title ?? 'Workout',
        sport: details?.sport ?? nullable(item.sportTypeKey),
        description: details?.description ?? null,
        estimated_duration_s: details?.estimated_duration_s ?? null,
        estimated_distance_m: details?.estimated_distance_m ?? null,
        steps: details?.steps ?? null,
      },
    ]
  })
}
