import { describe, expect, it } from 'vitest'

import reference from '../../test/workouts.json' with { type: 'json' }

import {
  buildWorkout,
  findExercises,
  formatPace,
  parseDuration,
  parsePace,
  type WorkoutInput,
} from './workout-builder.ts'

const HR = { low: 120, high: 150 }

const built = (input: WorkoutInput) => {
  const result = buildWorkout(input)
  if (!result.ok) throw new Error(result.errors.join('; '))
  return result
}

const errors = (input: WorkoutInput) => {
  const result = buildWorkout(input)
  if (result.ok) throw new Error('built')
  return result.errors
}

const run = (steps: WorkoutInput['steps']): WorkoutInput => ({
  name: 'Test',
  sport: 'running',
  steps,
})

describe('conversions', () => {
  it('reads paces as seconds per km', () => {
    for (const pace of [365, "6'05/km", "6'05", '6:05', `6'05"/km`, '6:05 min/km', '6’05/km']) {
      expect(parsePace(pace), String(pace)).toBe(365)
    }
    for (const pace of ['fast', "6'75", 60, 2000, '', "65'00"]) {
      expect(parsePace(pace), String(pace)).toBeUndefined()
    }
    expect(formatPace(365)).toBe("6'05/km")
  })

  it('reads durations as seconds', () => {
    const cases: ReadonlyArray<readonly [number | string, number]> = [
      [180, 180],
      ['180', 180],
      ['3:00', 180],
      ['1:05:00', 3900],
      ["45'", 2700],
      ['45 min', 2700],
      [`4'30"`, 270],
      ["4'30", 270],
      ['90s', 90],
      ['1h', 3600],
      ["1h30'", 5400],
      [1.5 * 60, 90],
    ]
    for (const [input, seconds] of cases) expect(parseDuration(input), String(input)).toBe(seconds)
    for (const input of [0, -5, 'soon', '3:75', 100_000]) {
      expect(parseDuration(input), String(input)).toBeUndefined()
    }
  })
})

describe('buildWorkout', () => {
  // The reference plan script's own payloads (test/workouts.json), step for step
  it('builds what the reference script posted: HR targets, strides in a repeat group', () => {
    expect(
      built({
        name: "Test - Easy 40' + 3 strides",
        sport: 'running',
        description: 'Easy run.',
        estimated_minutes: 40,
        steps: [
          { duration: '37:00', hr: HR, note: 'Easy' },
          {
            repeat: 3,
            steps: [
              { duration: 20, note: 'Stride' },
              { kind: 'recovery', duration: '40s', note: 'Walk back' },
            ],
          },
        ],
      }).payload
    ).toEqual(reference.easy)
  })

  it('builds intervals with pace targets, warm-up and cool-down, and estimates the duration', () => {
    const result = built({
      name: "Test - Threshold 6x3'",
      sport: 'running',
      description: 'Threshold.',
      steps: [
        { kind: 'warmup', duration: "15'", hr: HR, note: 'Warm-up' },
        {
          repeat: 6,
          steps: [
            // Either order: the slower bound goes first
            { duration: '3:00', pace: { slow: '5:35', fast: "5'45/km" } },
            { kind: 'recovery', duration: 90, note: 'Jog' },
          ],
        },
        { kind: 'cooldown', duration: 600, hr: HR, note: 'Cool-down' },
      ],
    })
    expect(result.payload).toEqual(reference.threshold)
    expect(result.steps).toEqual([
      'warmup 15:00 HR 120-150 (Warm-up)',
      '6× [interval 3:00 pace 5:35/km-5:45/km, recovery 1:30 (Jog)]',
      'cooldown 10:00 HR 120-150 (Cool-down)',
    ])
  })

  it('builds distance steps', () => {
    expect(
      built({
        name: 'Test - Race 21.1 km',
        sport: 'running',
        description: 'Race.',
        estimated_minutes: 127,
        steps: [
          { distance_m: 3000, pace: { slow: 380, fast: 370 }, note: 'Start easy' },
          { distance_m: 12_000, pace: { slow: "6'08", fast: "6'00/km" } },
          { distance_m: 6098, note: 'Finish' },
        ],
      }).payload
    ).toEqual(reference.race)
  })

  it("builds strength circuits from Garmin's catalog, by name or by keys", () => {
    expect(
      built({
        name: 'Test - Core routine',
        sport: 'strength_training',
        description: 'Core.',
        estimated_minutes: 6,
        steps: [
          { exercise: 'Cat Camel', reps: 10, note: 'Slow' },
          {
            repeat: 2,
            steps: [
              { category: 'PLANK', exercise_name: 'SIDE_PLANK', duration: 30, note: 'Left side' },
              { kind: 'rest', duration: 15 },
            ],
          },
          { exercise: 'hip raise', reps: 12 },
        ],
      }).payload
    ).toEqual(reference.core)
  })

  it('needs exactly one way to end each step', () => {
    expect(errors(run([{ hr: HR }]))).toEqual([
      'steps[0]: give exactly one of duration, distance_m, reps, lap_button: true',
    ])
    expect(errors(run([{ duration: 60, distance_m: 400 }]))[0]).toMatch(/exactly one/u)
    expect(
      built(run([{ lap_button: true, note: 'Warm up' }])).payload.workoutSegments[0]
        ?.workoutSteps[0]
    ).toMatchObject({ endCondition: { conditionTypeKey: 'lap.button' }, endConditionValue: null })
  })

  it('refuses unreadable or contradictory targets', () => {
    expect(errors(run([{ duration: 60, pace: { slow: 'slow', fast: "5'00" } }]))[0]).toMatch(
      /pace .* unreadable/u
    )
    expect(errors(run([{ duration: 60, pace: { slow: 360, fast: 350 }, hr: HR }]))[0]).toMatch(
      /one target at most/u
    )
    expect(errors(run([{ duration: 60, hr: { low: 150, high: 150 } }]))[0]).toMatch(/hr:/u)
    expect(errors(run([{ duration: 'later' }]))[0]).toMatch(/duration "later" unreadable/u)
  })

  it("checks exercises against Garmin's catalog, suggesting close ones", () => {
    const strength = (steps: WorkoutInput['steps']): WorkoutInput => ({
      name: 'Test',
      sport: 'strength_training',
      steps,
    })
    expect(errors(strength([{ exercise: 'Superman', reps: 10 }]))[0]).toMatch(
      /unknown exercise "Superman" \(close: .*"Superman from Floor"/u
    )
    expect(errors(strength([{ category: 'PLANK', exercise_name: 'NOPE', reps: 10 }]))[0]).toMatch(
      /unknown exercise PLANK\/NOPE/u
    )
    expect(errors(strength([{ reps: 10 }]))[0]).toMatch(/needs exercise/u)
    expect(errors(strength([{ kind: 'rest', duration: 15, exercise: 'Cat Camel' }]))[0]).toMatch(
      /rest step has no exercise/u
    )
    expect(
      errors(strength([{ exercise: 'Cat Camel', reps: 10, pace: { slow: 360, fast: 350 } }]))[0]
    ).toMatch(/no pace target/u)
    expect(errors(run([{ exercise: 'Cat Camel', reps: 10 }]))[0]).toMatch(/for strength workouts/u)
    expect(findExercises('superman floor').map((entry) => entry.exercise)).toContain(
      'SUPERMAN_FROM_FLOOR'
    )
    expect(findExercises('side plank')[0]).toEqual({
      name: 'Side Plank',
      category: 'PLANK',
      exercise: 'SIDE_PLANK',
    })
  })

  it('keeps repeat groups to repeat and steps', () => {
    expect(errors(run([{ repeat: 3, steps: [] }]))[0]).toMatch(/1 to 50 steps/u)
    expect(errors(run([{ repeat: 0, steps: [{ duration: 60 }] }]))[0]).toMatch(/repeat: a whole/u)
    expect(errors(run([{ repeat: 3, duration: 60, steps: [{ duration: 60 }] }]))[0]).toMatch(
      /only repeat and steps \(not duration\)/u
    )
    // Every problem at once, each named by its step
    expect(
      errors(run([{ duration: 'x' }, { repeat: 2, steps: [{ duration: 60 }, { reps: 0 }] }]))
    ).toEqual([
      'steps[0]: duration "x" unreadable',
      'steps[1].steps[1]: reps: a whole number from 1 to 500',
    ])
  })
})
