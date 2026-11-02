import { Schema } from 'effect'

import { describeStep } from '../connect.ts'

import catalog from './exercises.json' with { type: 'json' }

// Garmin Connect workouts from inputs a language model writes well (paces as "6'05/km", HR as bpm,
// durations as "3:00"): the JSON Garmin's workout editor posts to /workout-service/workout, step
// for step (runs with pace or HR targets, warm-up and cool-down, repeat groups; strength circuits
// of exercises from Garmin's catalog). Pure: workouts.ts sends it.

// --- Inputs

const Pace = Schema.Union([Schema.Finite, Schema.String]).annotate({
  description: `Seconds per km (365) or min'sec per km ("6'05/km", "6:05")`,
})

const Duration = Schema.Union([Schema.Finite, Schema.String]).annotate({
  description: `Seconds (180) or "3:00", "1:05:00", "45'", "4'30\\"", "90s"`,
})

const StepKind = Schema.Literals(['warmup', 'interval', 'recovery', 'cooldown', 'rest'])

const stepFields = {
  kind: Schema.optionalKey(StepKind).annotate({ description: "The step's type; default interval" }),
  duration: Schema.optionalKey(Duration),
  distance_m: Schema.optionalKey(Schema.Finite.annotate({ description: 'Metres' })),
  reps: Schema.optionalKey(Schema.Int.annotate({ description: 'Repetitions (strength)' })),
  lap_button: Schema.optionalKey(
    Schema.Boolean.annotate({ description: 'Ends when the lap button is pressed' })
  ),
  pace: Schema.optionalKey(
    Schema.Struct({ slow: Pace, fast: Pace }).annotate({
      description: 'Pace target, e.g. { slow: "6\'10/km", fast: "6\'00/km" } (running)',
    })
  ),
  hr: Schema.optionalKey(
    Schema.Struct({ low: Schema.Int, high: Schema.Int }).annotate({
      description: 'Heart-rate target in bpm, e.g. { low: 120, high: 150 }',
    })
  ),
  exercise: Schema.optionalKey(
    Schema.String.annotate({
      description:
        'Strength: the exercise\'s display name in Garmin\'s catalog, e.g. "Dead Bug" (find_exercises)',
    })
  ),
  category: Schema.optionalKey(
    Schema.String.annotate({
      description: 'Strength, instead of exercise: Garmin\'s category key, e.g. "PLANK"',
    })
  ),
  exercise_name: Schema.optionalKey(
    Schema.String.annotate({
      description: 'Strength, with category: Garmin\'s exercise key, e.g. "SIDE_PLANK"',
    })
  ),
  note: Schema.optionalKey(Schema.String.annotate({ description: 'Shown on the watch' })),
}

export const StepSchema = Schema.Struct(stepFields).annotate({
  description:
    'One step. It ends after exactly one of duration, distance_m, reps, or lap_button: true. One target at most: pace or hr.',
})
export type StepInput = typeof StepSchema.Type

export const TopStepSchema = Schema.Struct({
  ...stepFields,
  repeat: Schema.optionalKey(
    Schema.Int.annotate({ description: 'A repeat group: how many times its steps run' })
  ),
  steps: Schema.optionalKey(
    Schema.Array(StepSchema).annotate({ description: "The repeat group's steps (with repeat)" })
  ),
}).annotate({
  description:
    'A step, or a repeat group: { repeat: 6, steps: [{ duration: "3:00", pace: {...} }, { kind: "recovery", duration: 90 }] }',
})
export type TopStepInput = typeof TopStepSchema.Type

export const Sport = Schema.Literals(['running', 'strength_training'])

export const WorkoutSchema = Schema.Struct({
  name: Schema.String.annotate({
    description:
      'The workout\'s name as the watch shows it, e.g. "Plan - tue 03/11 - Easy 40\'" (one workout per date for runs)',
  }),
  sport: Sport,
  description: Schema.optionalKey(Schema.String),
  steps: Schema.Array(TopStepSchema),
  estimated_minutes: Schema.optionalKey(
    Schema.Finite.annotate({ description: 'Shown by Garmin; computed from the steps by default' })
  ),
})
export type WorkoutInput = typeof WorkoutSchema.Type

// --- Conversions

// Seconds, from 180, "180", "3:00", "1:05:00", "45'", "4'30\"", "90s"
export const parseDuration = (input: number | string): number | undefined => {
  if (typeof input === 'number') {
    return Number.isFinite(input) && input > 0 && input <= 86_400 ? input : undefined
  }
  const value = input.trim().toLowerCase().replaceAll('’', "'").replaceAll('”', '"')
  let match: RegExpExecArray | null
  let seconds: number | undefined
  if ((match = /^(\d+(?:\.\d+)?)\s*(?:s|sec|secs|seconds)?$/u.exec(value))) {
    seconds = Number(match[1])
  } else if ((match = /^(\d+):([0-5]\d)$/u.exec(value))) {
    seconds = Number(match[1]) * 60 + Number(match[2])
  } else if ((match = /^(\d+):([0-5]\d):([0-5]\d)$/u.exec(value))) {
    seconds = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])
  } else if ((match = /^(\d+(?:\.\d+)?)\s*(?:'|min|mins|minutes|mn)$/u.exec(value))) {
    seconds = Number(match[1]) * 60
  } else if ((match = /^(\d+)\s*'\s*([0-5]?\d)\s*(?:"|'')?$/u.exec(value))) {
    seconds = Number(match[1]) * 60 + Number(match[2])
  } else if ((match = /^(\d+)\s*h\s*(?:([0-5]?\d)\s*(?:'|min)?)?$/u.exec(value))) {
    seconds = Number(match[1]) * 3600 + Number(match[2] ?? 0) * 60
  }
  return seconds === undefined ? undefined : parseDuration(seconds)
}

// Seconds per km, from 365, "6'05/km", "6'05", "6:05", "6'05\"/km", "6:05 min/km"
export const parsePace = (input: number | string): number | undefined => {
  const seconds =
    typeof input === 'number'
      ? input
      : (() => {
          const value = input
            .trim()
            .toLowerCase()
            .replaceAll('’', "'")
            .replaceAll('”', '"')
            .replace(/\s*(?:min)?\s*\/\s*km$/u, '')
          const match = /^(\d{1,2})\s*(?:'|:)\s*([0-5]\d)\s*(?:"|'')?$/u.exec(value)
          return match === null ? undefined : Number(match[1]) * 60 + Number(match[2])
        })()
  // 2'00 to 20'00 per km
  return seconds !== undefined && Number.isFinite(seconds) && seconds >= 120 && seconds <= 1200
    ? seconds
    : undefined
}

export const formatPace = (seconds: number) => {
  const whole = Math.round(seconds)
  return `${Math.floor(whole / 60)}'${String(whole % 60).padStart(2, '0')}/km`
}

// --- Garmin's catalog of strength exercises

export interface Exercise {
  readonly name: string
  readonly category: string
  readonly exercise: string
}

export const EXERCISES: ReadonlyArray<Exercise> = catalog.exercises.map(
  ([name = '', category = '', exercise = '']) => ({ name, category, exercise })
)

const byName = new Map(EXERCISES.map((entry) => [entry.name.toLowerCase(), entry]))
const byKeys = new Map(EXERCISES.map((entry) => [`${entry.category}/${entry.exercise}`, entry]))

// The exercises whose name or keys hold every word of `query`, case-insensitive, closest first
export const findExercises = (query: string, limit = 25): ReadonlyArray<Exercise> => {
  const words = query
    .toLowerCase()
    .split(/[\s_/-]+/u)
    .filter((word) => word !== '')
  if (words.length === 0) return []
  const phrase = words.join(' ')
  // The exact name first, then the names it starts, then the shortest
  const rank = (entry: Exercise) => {
    const name = entry.name.toLowerCase()
    return (name === phrase ? 0 : name.startsWith(phrase) ? 1 : 2) * 1000 + name.length
  }
  return EXERCISES.filter((entry) => {
    const text = `${entry.name} ${entry.category} ${entry.exercise}`
      .toLowerCase()
      .replaceAll('_', ' ')
    return words.every((word) => text.includes(word))
  })
    .toSorted((a, b) => rank(a) - rank(b))
    .slice(0, limit)
}

const exerciseOf = (step: StepInput): Exercise | string => {
  if (step.exercise !== undefined) {
    const found = byName.get(step.exercise.trim().toLowerCase())
    if (found !== undefined) return found
    const close = findExercises(step.exercise, 5).map((entry) => `"${entry.name}"`)
    return `unknown exercise "${step.exercise}"${close.length > 0 ? ` (close: ${close.join(', ')})` : ' (find_exercises lists them)'}`
  }
  if (step.category !== undefined && step.exercise_name !== undefined) {
    const found = byKeys.get(`${step.category}/${step.exercise_name}`)
    return (
      found ?? `unknown exercise ${step.category}/${step.exercise_name} (find_exercises lists them)`
    )
  }
  return 'a strength step needs exercise (or category and exercise_name)'
}

// --- Garmin's JSON

const STEP_TYPES = {
  warmup: { stepTypeId: 1, stepTypeKey: 'warmup', displayOrder: 1 },
  cooldown: { stepTypeId: 2, stepTypeKey: 'cooldown', displayOrder: 2 },
  interval: { stepTypeId: 3, stepTypeKey: 'interval', displayOrder: 3 },
  recovery: { stepTypeId: 4, stepTypeKey: 'recovery', displayOrder: 4 },
  rest: { stepTypeId: 5, stepTypeKey: 'rest', displayOrder: 5 },
} as const

const CONDITIONS = {
  'lap.button': { conditionTypeId: 1, conditionTypeKey: 'lap.button', displayOrder: 1 },
  time: { conditionTypeId: 2, conditionTypeKey: 'time', displayOrder: 2 },
  distance: { conditionTypeId: 3, conditionTypeKey: 'distance', displayOrder: 3 },
  reps: { conditionTypeId: 10, conditionTypeKey: 'reps', displayOrder: 10 },
} as const

const NO_TARGET = { workoutTargetTypeId: 1, workoutTargetTypeKey: 'no.target', displayOrder: 1 }
const HR_TARGET = {
  workoutTargetTypeId: 4,
  workoutTargetTypeKey: 'heart.rate.zone',
  displayOrder: 4,
}
const PACE_TARGET = { workoutTargetTypeId: 6, workoutTargetTypeKey: 'pace.zone', displayOrder: 6 }

const SPORTS = {
  running: { sportTypeId: 1, sportTypeKey: 'running', displayOrder: 1 },
  strength_training: { sportTypeId: 5, sportTypeKey: 'strength_training', displayOrder: 5 },
} as const

export interface ExecutableStep {
  readonly type: 'ExecutableStepDTO'
  readonly stepOrder: number
  readonly stepType: (typeof STEP_TYPES)[keyof typeof STEP_TYPES]
  readonly endCondition: (typeof CONDITIONS)[keyof typeof CONDITIONS] & {
    readonly displayable: true
  }
  readonly endConditionValue: number | null
  readonly targetType: typeof NO_TARGET | typeof HR_TARGET | typeof PACE_TARGET
  readonly targetValueOne?: number
  readonly targetValueTwo?: number
  readonly description?: string
  readonly category?: string
  readonly exerciseName?: string
}

export interface RepeatGroup {
  readonly type: 'RepeatGroupDTO'
  readonly stepOrder: number
  readonly stepType: {
    readonly stepTypeId: 6
    readonly stepTypeKey: 'repeat'
    readonly displayOrder: 6
  }
  readonly numberOfIterations: number
  readonly endCondition: {
    readonly conditionTypeId: 7
    readonly conditionTypeKey: 'iterations'
    readonly displayOrder: 7
    readonly displayable: false
  }
  readonly endConditionValue: number
  readonly smartRepeat: false
  readonly workoutSteps: ReadonlyArray<ExecutableStep>
}

export interface WorkoutPayload {
  readonly workoutName: string
  readonly description?: string
  readonly sportType: (typeof SPORTS)[keyof typeof SPORTS]
  readonly estimatedDurationInSecs: number
  readonly workoutSegments: ReadonlyArray<{
    readonly segmentOrder: 1
    readonly sportType: (typeof SPORTS)[keyof typeof SPORTS]
    readonly workoutSteps: ReadonlyArray<ExecutableStep | RepeatGroup>
  }>
}

export type Built =
  | {
      readonly ok: true
      readonly payload: WorkoutPayload
      // One readable line per step, as planned_workouts shows them
      readonly steps: ReadonlyArray<string>
    }
  | { readonly ok: false; readonly errors: ReadonlyArray<string> }

const MAX_NAME = 100
const MAX_STEPS = 50
const MAX_REPEAT = 99
const MAX_TEXT = 1000
// Seconds a strength repetition counts for in the estimated duration
const REP_SECONDS = 4
// A distance step's pace when it has no pace target, for the estimated duration
const DEFAULT_PACE = 360

// The workout's JSON for Garmin, or every problem in the input (each named by its step)
export const buildWorkout = (input: WorkoutInput): Built => {
  const errors: Array<string> = []
  const strength = input.sport === 'strength_training'
  let order = 0
  let seconds = 0

  const name = input.name.trim()
  if (name === '' || name.length > MAX_NAME) errors.push(`name: 1 to ${MAX_NAME} characters`)
  if ((input.description?.length ?? 0) > MAX_TEXT) {
    errors.push(`description: ${MAX_TEXT} characters at most`)
  }
  if (input.steps.length === 0 || input.steps.length > MAX_STEPS) {
    errors.push(`steps: 1 to ${MAX_STEPS}`)
  }

  // One executable step, `times` over (its repeat group's iterations) for the estimate
  const executable = (
    step: StepInput,
    where: string,
    times: number
  ): ExecutableStep | undefined => {
    const problems: Array<string> = []
    const kind = step.kind ?? 'interval'
    const ends = [
      step.duration !== undefined,
      step.distance_m !== undefined,
      step.reps !== undefined,
      step.lap_button === true,
    ].filter(Boolean).length
    if (ends !== 1) {
      problems.push('give exactly one of duration, distance_m, reps, lap_button: true')
    }
    let condition: keyof typeof CONDITIONS = 'lap.button'
    let value: number | null = null
    if (step.duration !== undefined) {
      const parsed = parseDuration(step.duration)
      if (parsed === undefined)
        problems.push(`duration ${JSON.stringify(step.duration)} unreadable`)
      condition = 'time'
      value = parsed ?? null
    } else if (step.distance_m !== undefined) {
      if (!(step.distance_m > 0 && step.distance_m <= 100_000)) {
        problems.push('distance_m: 1 to 100000')
      }
      condition = 'distance'
      value = step.distance_m
    } else if (step.reps !== undefined) {
      if (!(Number.isInteger(step.reps) && step.reps > 0 && step.reps <= 500)) {
        problems.push('reps: a whole number from 1 to 500')
      }
      condition = 'reps'
      value = step.reps
    }

    let target: Pick<ExecutableStep, 'targetType' | 'targetValueOne' | 'targetValueTwo'> = {
      targetType: NO_TARGET,
    }
    let paceSeconds: number | undefined
    if (step.pace !== undefined && step.hr !== undefined)
      problems.push('one target at most: pace or hr')
    if (step.pace !== undefined) {
      if (strength) problems.push('no pace target on a strength step')
      const one = parsePace(step.pace.slow)
      const two = parsePace(step.pace.fast)
      if (one === undefined || two === undefined) {
        problems.push(`pace ${JSON.stringify(step.pace)} unreadable (e.g. "6'05/km", or 365 s/km)`)
      } else {
        // targetValueOne is the slower bound, in m/s
        const slow = Math.max(one, two)
        const fast = Math.min(one, two)
        target = {
          targetType: PACE_TARGET,
          targetValueOne: 1000 / slow,
          targetValueTwo: 1000 / fast,
        }
        paceSeconds = (slow + fast) / 2
      }
    } else if (step.hr !== undefined) {
      const low = Math.min(step.hr.low, step.hr.high)
      const high = Math.max(step.hr.low, step.hr.high)
      if (
        Number.isInteger(low) &&
        Number.isInteger(high) &&
        low >= 40 &&
        high <= 230 &&
        low < high
      ) {
        target = { targetType: HR_TARGET, targetValueOne: low, targetValueTwo: high }
      } else {
        problems.push('hr: whole bpm, low < high, between 40 and 230')
      }
    }

    let exercise: Exercise | undefined
    const named =
      step.exercise !== undefined || step.category !== undefined || step.exercise_name !== undefined
    if (strength && kind !== 'rest') {
      const found = exerciseOf(step)
      if (typeof found === 'string') problems.push(found)
      else exercise = found
    } else if (named) {
      problems.push(
        strength ? 'a rest step has no exercise' : 'exercises are for strength workouts'
      )
    }
    if ((step.note?.length ?? 0) > MAX_TEXT) problems.push(`note: ${MAX_TEXT} characters at most`)

    if (problems.length > 0) {
      errors.push(...problems.map((problem) => `${where}: ${problem}`))
      return undefined
    }
    seconds +=
      times *
      (condition === 'time'
        ? (value ?? 0)
        : condition === 'distance'
          ? ((value ?? 0) / 1000) * (paceSeconds ?? DEFAULT_PACE)
          : condition === 'reps'
            ? (value ?? 0) * REP_SECONDS
            : 0)
    order += 1
    return {
      type: 'ExecutableStepDTO',
      stepOrder: order,
      stepType: STEP_TYPES[kind],
      endCondition: { ...CONDITIONS[condition], displayable: true },
      endConditionValue: value,
      ...target,
      ...(step.note === undefined || step.note.trim() === ''
        ? {}
        : { description: step.note.trim() }),
      ...(exercise === undefined
        ? {}
        : { category: exercise.category, exerciseName: exercise.exercise }),
    }
  }

  const steps = input.steps.flatMap((step, index): Array<ExecutableStep | RepeatGroup> => {
    const where = `steps[${index}]`
    if (step.repeat === undefined && step.steps === undefined) {
      const built = executable(step, where, 1)
      return built === undefined ? [] : [built]
    }
    const times = step.repeat ?? 0
    const inner = step.steps ?? []
    const own = Object.keys(step).filter((key) => key !== 'repeat' && key !== 'steps')
    if (!(Number.isInteger(times) && times >= 1 && times <= MAX_REPEAT)) {
      errors.push(`${where}: repeat: a whole number from 1 to ${MAX_REPEAT}, with steps`)
      return []
    }
    if (inner.length === 0 || inner.length > MAX_STEPS) {
      errors.push(`${where}: a repeat group has 1 to ${MAX_STEPS} steps`)
      return []
    }
    if (own.length > 0) {
      errors.push(`${where}: a repeat group has only repeat and steps (not ${own.join(', ')})`)
      return []
    }
    order += 1
    const groupOrder = order
    const children = inner.flatMap((child, at) => {
      const built = executable(child, `${where}.steps[${at}]`, times)
      return built === undefined ? [] : [built]
    })
    return [
      {
        type: 'RepeatGroupDTO',
        stepOrder: groupOrder,
        stepType: { stepTypeId: 6, stepTypeKey: 'repeat', displayOrder: 6 },
        numberOfIterations: times,
        endCondition: {
          conditionTypeId: 7,
          conditionTypeKey: 'iterations',
          displayOrder: 7,
          displayable: false,
        },
        endConditionValue: times,
        smartRepeat: false,
        workoutSteps: children,
      },
    ]
  })

  if (
    input.estimated_minutes !== undefined &&
    !(input.estimated_minutes > 0 && input.estimated_minutes <= 1440)
  ) {
    errors.push('estimated_minutes: 1 to 1440')
  }
  if (errors.length > 0) return { ok: false, errors }

  const sport = SPORTS[input.sport]
  const description = input.description?.trim()
  const payload: WorkoutPayload = {
    workoutName: name,
    ...(description === undefined || description === '' ? {} : { description }),
    sportType: sport,
    estimatedDurationInSecs: Math.round(
      input.estimated_minutes === undefined ? seconds : input.estimated_minutes * 60
    ),
    workoutSegments: [{ segmentOrder: 1, sportType: sport, workoutSteps: steps }],
  }
  return { ok: true, payload, steps: steps.map((step) => describeStep(step)) }
}
