import { describe, expect, it } from 'vitest'

import { STAGES, stageParts } from './parts.ts'

describe('parts', () => {
  it('makes new parts per night, the stages untouched', () => {
    const one = stageParts({ deep_s: 1, light_s: 2, rem_s: 3, awake_s: 4 })
    const two = stageParts({ deep_s: 5, light_s: null, rem_s: 7, awake_s: 8 })
    expect(one.map((part) => part.value)).toEqual([1, 2, 3, 4])
    expect(two.map((part) => part.value)).toEqual([5, 0, 7, 8])
    expect(STAGES.some((stage) => 'value' in stage)).toBe(false)
  })
})
