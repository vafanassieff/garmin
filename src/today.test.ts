import { describe, expect, it } from 'vitest'

import { addDays } from './days.ts'
import { plannedBurn, type Reading, verdict } from './today.ts'

const TODAY = '2026-11-23'

// `count` nights before today (yesterday first), each its HRV and resting HR from the lists in turn
const history = (
  count: number,
  { hrv = [40], resting = [54] }: { readonly hrv?: number[]; readonly resting?: number[] } = {}
): Array<Reading> =>
  Array.from({ length: count }, (_, index) => ({
    day: addDays(TODAY, -1 - index),
    hrv: hrv[index % hrv.length] ?? null,
    resting_hr: resting[index % resting.length] ?? null,
    recovery_time_h: 0,
  }))

const tonight = (night: Partial<Reading>): Reading => ({
  day: TODAY,
  hrv: 40,
  resting_hr: 54,
  recovery_time_h: 0,
  ...night,
})

const judge = (night: Partial<Reading>, before = history(28)) =>
  verdict(TODAY, [tonight(night), ...before])

describe('verdict', () => {
  it('waits for the night: no reading for today, or one without either measure', () => {
    expect(verdict(TODAY, history(28))).toEqual({ kind: 'no-night' })
    expect(judge({ hrv: null, resting_hr: null })).toEqual({ kind: 'no-night' })
    // Before even counting the nights
    expect(verdict(TODAY, history(3))).toEqual({ kind: 'no-night' })
    expect(judge({ hrv: null, resting_hr: null }, history(3))).toEqual({ kind: 'no-night' })
  })

  it('needs 7 nights for a normal', () => {
    expect(judge({}, history(6))).toEqual({ kind: 'too-few', nights: { hrv: 6, resting_hr: 6 } })
    expect(judge({}, history(7))).toMatchObject({ kind: 'judged', light: 'green' })
  })

  it('is green on both measures within their normal', () => {
    expect(judge({ hrv: 44, resting_hr: 53 })).toEqual({
      kind: 'judged',
      light: 'green',
      reasons: [],
      hrv: { value: 44, normal: 40 },
      resting_hr: { value: 53, normal: 54 },
      recovery_h: 0,
    })
  })

  it('holds back while Garmin counts more than 12 hours of recovery', () => {
    expect(judge({ recovery_time_h: 12 })).toMatchObject({ light: 'green' })
    expect(judge({ recovery_time_h: 13 })).toMatchObject({
      light: 'orange',
      reasons: ['récupération Garmin : encore 13 h'],
    })
  })

  it('is orange with one measure off its normal, red with both', () => {
    expect(judge({ resting_hr: 57 })).toMatchObject({
      light: 'orange',
      reasons: ['FC au repos 57 (normale 54)'],
    })
    expect(judge({ hrv: 36, resting_hr: 57, recovery_time_h: 81 })).toMatchObject({
      light: 'red',
      reasons: [
        'HRV 36 (normale 40)',
        'FC au repos 57 (normale 54)',
        'récupération Garmin : encore 81 h',
      ],
    })
  })

  it('needs 3 bpm or 4 ms off a steady normal, one SD off a noisy one', () => {
    expect(judge({ resting_hr: 56, hrv: 37 })).toMatchObject({ light: 'green' })
    expect(judge({ resting_hr: 57 })).toMatchObject({ light: 'orange' })
    expect(judge({ hrv: 36 })).toMatchObject({ light: 'orange' })
    // Resting HR 50 and 60 in turn: mean 55, SD 5, above the floor
    const noisy = history(28, { resting: [50, 60] })
    expect(judge({ resting_hr: 59 }, noisy)).toMatchObject({ light: 'green' })
    expect(judge({ resting_hr: 60 }, noisy)).toMatchObject({ light: 'orange' })
  })

  it("judges against the 28 days before: not tonight's, nor older ones", () => {
    // Tonight's 70 would lift its own normal past 57 were it counted
    expect(judge({ resting_hr: 70 })).toMatchObject({
      resting_hr: { value: 70, normal: 54 },
      light: 'orange',
    })
    // A 29th night back is outside the normal
    const old = { day: addDays(TODAY, -29), hrv: 10, resting_hr: 90, recovery_time_h: 0 }
    expect(judge({}, [...history(28), old])).toMatchObject({
      hrv: { normal: 40 },
      resting_hr: { normal: 54 },
    })
  })

  it('is never green on one measure', () => {
    expect(judge({ hrv: null })).toMatchObject({
      light: 'orange',
      reasons: ['HRV non mesurée cette nuit'],
      hrv: null,
    })
    // HRV recorded on 6 nights only: no normal for it
    const sparse = history(28).map((reading, index) =>
      index < 6 ? reading : { ...reading, hrv: null }
    )
    expect(judge({}, sparse)).toMatchObject({
      light: 'orange',
      reasons: ['pas assez de nuits pour la normale de la HRV'],
      hrv: null,
      resting_hr: { value: 54, normal: 54 },
    })
  })
})

describe('plannedBurn', () => {
  it('adds each session net of the resting burn of its minutes', () => {
    expect(plannedBurn(null, [])).toEqual({ kind: 'no-rest' })
    expect(plannedBurn(1440, [])).toEqual({ kind: 'known', rest: 1440, sessions: 0, total: 1440 })
    expect(plannedBurn(1440, [{ kcal: 600, minutes: 60 }])).toEqual({
      kind: 'known',
      rest: 1440,
      sessions: 540,
      total: 1980,
    })
    expect(
      plannedBurn(1440, [
        { kcal: 600, minutes: 60 },
        { kcal: 200, minutes: 30 },
      ])
    ).toEqual({ kind: 'known', rest: 1440, sessions: 710, total: 2150 })
  })

  it('says when a session has no cost rather than leaving it out', () => {
    expect(plannedBurn(1440, [{ kcal: null, minutes: 30 }])).toEqual({
      kind: 'session-unknown',
      rest: 1440,
    })
    expect(plannedBurn(1440, [{ kcal: 300, minutes: null }])).toEqual({
      kind: 'session-unknown',
      rest: 1440,
    })
  })
})
