import { expect, it } from '@effect/vitest'
import { Effect } from 'effect'

import { fitRun } from '../test/fixtures.ts'

import { fitFileType, fitStart, parseFit } from './fit.ts'

it.effect('reads an activity: summary, zones, laps, a sample a second', () =>
  Effect.gen(function* () {
    const fit = yield* parseFit(fitRun({ seconds: 1200, lapSeconds: 500 }))
    expect(fit).toMatchObject({
      fit_sport: 'running',
      start_time: '2026-10-31T06:12:40.000Z',
      utc_offset_s: 3600,
      moving_s: 1200,
      distance_m: 3600,
      avg_hr: 140,
      // Strides of one foot ×2, as Garmin Connect shows them
      avg_cadence: 161,
      training_load: 80.5,
      aerobic_te: 3.1,
      rpe: 5,
      feel: 75,
      hr_z1_s: 20,
      hr_z5_s: 240,
      hr_zone_bounds: '[100,120,140,155,170,185]',
      workout_name: 'Easy 20',
      device: 'fr230',
      start_lat: 48.8556,
    })
    expect(fit.laps.map((lap) => lap.moving_s)).toEqual([500, 500, 200])
    expect(fit.samples).toHaveLength(1201)
    expect(fit.samples[600]).toMatchObject({
      t: 600,
      hr: 140,
      speed: 3,
      cadence: 161,
      distance: 1800,
    })
    expect(fit.polyline?.length).toBeGreaterThan(4)
  })
)

it.effect('refuses what is not an activity, says what it is', () =>
  Effect.gen(function* () {
    const settings = fitRun({ type: 'settings' })
    expect(fitFileType(settings)).toBe('settings')
    expect((yield* Effect.flip(parseFit(settings))).message).toBe(
      'a FIT file of type settings, not an activity'
    )
    expect((yield* Effect.flip(parseFit(new Uint8Array([1, 2, 3])))).message).toBe('not a FIT file')
    expect(fitStart(fitRun())).toBe('2026-10-31T06:12:40.000Z')
  })
)
