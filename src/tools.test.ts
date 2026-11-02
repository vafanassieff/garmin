import { describe, expect, it } from 'vitest'

import { clock, decoupling, kmSplits, type SamplePoint } from './tools.ts'

const steady = (seconds: number, speed: (t: number) => number, hr: (t: number) => number) => {
  const samples: Array<SamplePoint> = []
  let distance = 0
  for (let t = 0; t <= seconds; t += 1) {
    samples.push({ t, hr: hr(t), speed: speed(t), cadence: 160, alt: 50, distance, power: null })
    distance += speed(t)
  }
  return samples
}

describe('tools', () => {
  it('formats durations', () => {
    expect(clock(352.5)).toBe('5:53')
    expect(clock(4208)).toBe('1:10:08')
  })

  it('splits per km, the last one partial', () => {
    const splits = kmSplits(
      steady(
        900,
        () => 2.5,
        () => 140
      )
    )
    expect(splits.map((s) => [s.km, s.distance_km, s.pace, s.avg_hr])).toEqual([
      [1, 1, '6:40', 140],
      [2, 1, '6:40', 140],
      [3, 0.25, '6:40', 140],
    ])
  })

  it('leaves the pauses out of the splits', () => {
    // 1 km at 2.5 m/s, a 2-minute pause at 500 m, the samples resuming where they stopped
    const run = steady(
      400,
      () => 2.5,
      () => 140
    )
    const resumed = run.map((sample) =>
      sample.t > 200 ? { ...sample, t: sample.t + 120 } : sample
    )
    // 400 s of running less the second the pause swallowed, not 520 s
    expect(kmSplits(resumed).map((s) => [s.km, s.time, s.pace])).toEqual([[1, '6:39', '6:39']])
    // Smart recording, a sample every 15 s: its gaps are running
    const sparse = run.filter((sample) => sample.t % 15 === 0)
    expect(kmSplits(sparse).map((s) => [s.km, s.time])).toEqual([[1, '6:30']])
  })

  it('measures the drift of speed per heartbeat', () => {
    expect(
      decoupling(
        steady(
          3600,
          () => 3,
          () => 150
        )
      )
    ).toBe(0)
    // Same pace, HR 10 % higher in the second half
    expect(
      decoupling(
        steady(
          3600,
          () => 3,
          (t) => (t < 1800 ? 150 : 165)
        )
      )
    ).toBe(9.1)
    expect(
      decoupling(
        steady(
          100,
          () => 3,
          () => 150
        )
      )
    ).toBeNull()
  })
})
