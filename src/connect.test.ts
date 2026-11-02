import { Option } from 'effect'
import { describe, expect, it } from 'vitest'

import { apiSummary, dailyFile } from '../test/fixtures.ts'

import {
  apiActivity,
  apiBody,
  apiDaily,
  exportActivities,
  exportBody,
  exportDaily,
  plannedFromCalendar,
} from './connect.ts'

describe('activities', () => {
  it("reads the API's summary", () => {
    expect(Option.getOrThrow(apiActivity(apiSummary(1)))).toMatchObject({
      id: 1,
      name: 'Morning Run - Easy 20',
      sport: 'running',
      start_time: '2026-10-31T06:12:40.000Z',
      start_local: '2026-10-31T07:12:40',
      day: '2026-10-31',
      moving_s: 1190,
      training_load: 81.2,
      aerobic_te: 3.1,
      gear: 'Road Shoes',
    })
    expect(Option.isNone(apiActivity({ activityId: 1 }))).toBe(true)
  })

  it("reads the export's summaries in its units: ms, cm, cm/ms", () => {
    const [summary] = exportActivities([
      {
        summarizedActivitiesExport: [
          {
            activityId: 2,
            name: 'Trail Run',
            activityType: 'trail_running',
            startTimeGmt: Date.parse('2026-06-27T05:00:00Z'),
            startTimeLocal: Date.parse('2026-06-27T07:00:00Z'),
            duration: 15_600_000,
            movingDuration: 15_000_000,
            distance: 2_400_000,
            elevationGain: 180_000,
            avgHr: 160,
            avgSpeed: 0.154,
            activityTrainingLoad: 380,
          },
          { activityId: 'broken' },
        ],
      },
    ])
    expect(summary).toMatchObject({
      id: 2,
      sport: 'trail_running',
      start_local: '2026-06-27T07:00:00',
      day: '2026-06-27',
      elapsed_s: 15_600,
      moving_s: 15_000,
      distance_m: 24_000,
      ascent_m: 1800,
      avg_speed: 1.54,
      training_load: 380,
    })
  })
})

describe('days', () => {
  it("reads the sync's daily file; readiness is the morning's", () => {
    expect(apiDaily(dailyFile('2026-10-31'))).toMatchObject({
      day: '2026-10-31',
      sleep_s: 26_400,
      sleep_score: 78,
      sleep_start: '2026-10-30T21:10:00.000Z',
      hrv: 52,
      hrv_weekly: 50,
      hrv_baseline_low: 46,
      resting_hr: 58,
      body_battery_wake: 71,
      steps: 8420,
      readiness: 88,
      readiness_level: 'HIGH',
      acute_load: 61,
      vo2max: 51.3,
      race_half_s: 6440,
    })
  })

  it("reads the export's records, nested stress and body battery included", () => {
    const rows = exportDaily([
      {
        calendarDate: '2024-03-01',
        totalSteps: 9000,
        restingHeartRate: 55,
        allDayStress: { aggregatorList: [{ type: 'TOTAL', averageStressLevel: 31 }] },
        bodyBattery: { bodyBatteryStatList: [{ bodyBatteryStatType: 'WAKEUP', statsValue: 70 }] },
      },
      {
        calendarDate: '2024-03-01',
        sleepStartTimestampGMT: '2024-02-29T22:30:00.0',
        sleepEndTimestampGMT: '2024-03-01T06:00:00.0',
        deepSleepSeconds: 4000,
        lightSleepSeconds: 18_000,
        remSleepSeconds: 5000,
        sleepScores: { overallScore: 80 },
      },
      { calendarDate: { date: '2024-03-02' }, vo2MaxValue: 47, sport: 'RUNNING' },
    ])
    expect(rows).toEqual([
      expect.objectContaining({
        day: '2024-03-01',
        steps: 9000,
        resting_hr: 55,
        stress_avg: 31,
        body_battery_wake: 70,
        sleep_s: 27_000,
        sleep_score: 80,
        sleep_start: '2024-02-29T22:30:00.000Z',
      }),
      { day: '2024-03-02', vo2max: 47 },
    ])
  })
})

describe('weigh-ins', () => {
  it('turns grams into kilograms, zeros into nothing', () => {
    const month = apiBody({
      startDate: '2026-10-01',
      endDate: '2026-10-31',
      dateWeightList: [
        {
          calendarDate: '2026-10-31',
          timestampGMT: Date.parse('2026-10-31T06:40:10Z'),
          weight: 72_350,
          bmi: 0,
          bodyFat: 0,
          muscleMass: 31_200,
          sourceType: 'INDEX_SCALE',
        },
      ],
    })
    expect(month?.rows).toEqual([
      {
        time: '2026-10-31T06:40:10.000Z',
        day: '2026-10-31',
        weight_kg: 72.35,
        bmi: null,
        body_fat_pct: null,
        body_water_pct: null,
        muscle_mass_kg: 31.2,
        bone_mass_kg: null,
        visceral_fat: null,
        source: 'INDEX_SCALE',
      },
    ])
    expect(
      exportBody({ weights: [{ weight: 85_000, metaData: { calendarDate: '2024-01-02' } }] })
    ).toMatchObject([{ day: '2024-01-02', weight_kg: 85 }])
  })
})

it("describes a calendar's workouts step by step", () => {
  const workout = {
    workoutId: 7,
    workoutName: "Tempo 3x10'",
    description: 'Tempo pace',
    sportType: { sportTypeKey: 'running' },
    estimatedDurationInSecs: 3600,
    workoutSegments: [
      {
        workoutSteps: [
          {
            type: 'ExecutableStepDTO',
            stepType: { stepTypeKey: 'warmup' },
            endCondition: { conditionTypeKey: 'time' },
            endConditionValue: 900,
            targetType: { workoutTargetTypeKey: 'heart.rate.zone' },
            targetValueOne: 120,
            targetValueTwo: 145,
          },
          {
            type: 'RepeatGroupDTO',
            numberOfIterations: 3,
            workoutSteps: [
              {
                type: 'ExecutableStepDTO',
                stepType: { stepTypeKey: 'interval' },
                endCondition: { conditionTypeKey: 'time' },
                endConditionValue: 600,
                targetType: { workoutTargetTypeKey: 'pace.zone' },
                targetValueOne: 1000 / 330,
                targetValueTwo: 1000 / 320,
              },
              {
                type: 'ExecutableStepDTO',
                stepType: { stepTypeKey: 'recovery' },
                endCondition: { conditionTypeKey: 'distance' },
                endConditionValue: 400,
              },
            ],
          },
        ],
      },
    ],
  }
  const calendar = {
    calendarItems: [
      { id: 1, itemType: 'workout', title: workout.workoutName, date: '2026-11-05', workoutId: 7 },
      { id: 2, itemType: 'nap', date: '2026-11-05' },
      { id: null, itemType: 'weight' },
    ],
  }
  expect(plannedFromCalendar(calendar, (id) => (id === 7 ? workout : undefined))).toEqual([
    {
      id: 1,
      day: '2026-11-05',
      workout_id: 7,
      name: "Tempo 3x10'",
      sport: 'running',
      description: 'Tempo pace',
      estimated_duration_s: 3600,
      estimated_distance_m: null,
      steps: 'warmup 15:00 HR 120-145\n3× [interval 10:00 pace 5:20/km-5:30/km, recovery 400 m]',
    },
  ])
})
