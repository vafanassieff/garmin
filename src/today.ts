import { addDays } from './days.ts'
import { mean, present } from './numbers.ts'

// The home page's morning, without I/O: today's night against the user's own normal (the 28 days
// before it, today left out so that a bad night does not drag its own normal), and the day's
// planned energy. Green needs both measures; a missing one, a measure off its normal or Garmin's
// recovery still running holds it back.

export interface Reading {
  readonly day: string
  readonly hrv: number | null
  readonly resting_hr: number | null
  readonly recovery_time_h: number | null
}

export type Light = 'green' | 'orange' | 'red'

// Tonight's value and its normal (the mean, rounded)
export interface Measure {
  readonly value: number
  readonly normal: number
}

export type Verdict =
  // No reading for today, or one with neither measure (a sync before the night is processed)
  | { readonly kind: 'no-night' }
  // Neither measure has 7 nights in the 28 days before: the nights each has
  | {
      readonly kind: 'too-few'
      readonly nights: { readonly hrv: number; readonly resting_hr: number }
    }
  | {
      readonly kind: 'judged'
      readonly light: Light
      readonly reasons: ReadonlyArray<string>
      // null: tonight's value or its normal is missing
      readonly hrv: Measure | null
      readonly resting_hr: Measure | null
      readonly recovery_h: number | null
    }

const NORMAL_DAYS = 28
const MIN_NIGHTS = 7
// Garmin's recovery left above this: no hard session yet
const RECOVERING_H = 12

interface Normal {
  readonly mean: number
  readonly sd: number
}

// The mean and population SD of 7 values or more
const normalOf = (values: ReadonlyArray<number>): Normal | null => {
  const average = mean(values)
  if (average === null || values.length < MIN_NIGHTS) return null
  return { mean: average, sd: Math.sqrt(mean(values.map((value) => (value - average) ** 2)) ?? 0) }
}

type Assessment =
  | { readonly kind: 'missing'; readonly reason: string }
  | { readonly kind: 'off'; readonly measure: Measure; readonly reason: string }
  | { readonly kind: 'normal'; readonly measure: Measure }

// One measure tonight against its normal, `off` saying when it is on the wrong side of it
const assess = (
  label: string,
  value: number | null,
  normal: Normal | null,
  off: (value: number, normal: Normal) => boolean
): Assessment => {
  if (value === null) return { kind: 'missing', reason: `${label} non mesurée cette nuit` }
  if (normal === null) {
    return { kind: 'missing', reason: `pas assez de nuits pour la normale de la ${label}` }
  }
  const measure = { value, normal: Math.round(normal.mean) }
  return off(value, normal)
    ? { kind: 'off', measure, reason: `${label} ${value} (normale ${measure.normal})` }
    : { kind: 'normal', measure }
}

const measureOf = (assessment: Assessment) =>
  assessment.kind === 'missing' ? null : assessment.measure
const reasonOf = (assessment: Assessment) =>
  assessment.kind === 'normal' ? null : assessment.reason

export const verdict = (today: string, readings: ReadonlyArray<Reading>): Verdict => {
  const night = readings.find((reading) => reading.day === today)
  if (night === undefined || (night.hrv === null && night.resting_hr === null)) {
    return { kind: 'no-night' }
  }
  const before = readings.filter(
    (reading) => reading.day >= addDays(today, -NORMAL_DAYS) && reading.day < today
  )
  const hrvs = present(before.map((reading) => reading.hrv))
  const restings = present(before.map((reading) => reading.resting_hr))
  const hrvNormal = normalOf(hrvs)
  const restingNormal = normalOf(restings)
  if (hrvNormal === null && restingNormal === null) {
    return { kind: 'too-few', nights: { hrv: hrvs.length, resting_hr: restings.length } }
  }
  const hrv = assess('HRV', night.hrv, hrvNormal, (value, n) => value <= n.mean - Math.max(4, n.sd))
  const resting = assess(
    'FC au repos',
    night.resting_hr,
    restingNormal,
    (value, n) => value >= n.mean + Math.max(3, n.sd)
  )
  const recovering = (night.recovery_time_h ?? 0) > RECOVERING_H
  const offs = [hrv, resting].filter((assessment) => assessment.kind === 'off').length
  const missing = hrv.kind === 'missing' || resting.kind === 'missing'
  return {
    kind: 'judged',
    light: offs === 2 ? 'red' : offs === 1 || recovering || missing ? 'orange' : 'green',
    reasons: present([
      reasonOf(hrv),
      reasonOf(resting),
      recovering ? `récupération Garmin : encore ${night.recovery_time_h} h` : null,
    ]),
    hrv: measureOf(hrv),
    resting_hr: measureOf(resting),
    recovery_h: night.recovery_time_h,
  }
}

export type Burn =
  // No activity-free day measured in the 28 days
  | { readonly kind: 'no-rest' }
  // A planned session has no cost (no duration, or no activity of its sport to price it)
  | { readonly kind: 'session-unknown'; readonly rest: number }
  // sessions: their net share, total = rest + sessions
  | {
      readonly kind: 'known'
      readonly rest: number
      readonly sessions: number
      readonly total: number
    }

// The day's planned burn: the rest-day burn plus each session's calories minus the resting burn of
// its minutes, since Garmin's activity calories include the resting ones
export const plannedBurn = (
  rest: number | null,
  planned: ReadonlyArray<{ readonly kcal: number | null; readonly minutes: number | null }>
): Burn => {
  if (rest === null) return { kind: 'no-rest' }
  const priced = planned.flatMap(({ kcal, minutes }) =>
    kcal === null || minutes === null ? [] : [{ kcal, minutes }]
  )
  if (priced.length < planned.length) return { kind: 'session-unknown', rest }
  const sessions = Math.round(
    priced.reduce((sum, { kcal, minutes }) => sum + kcal - (rest / 1440) * minutes, 0)
  )
  return { kind: 'known', rest, sessions, total: rest + sessions }
}
