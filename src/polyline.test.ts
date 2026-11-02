import { describe, expect, it } from 'vitest'

import { decode, encode, simplify } from './polyline.ts'

describe('polyline', () => {
  it("encodes Google's example", () => {
    expect(
      encode([
        [38.5, -120.2],
        [40.7, -120.95],
        [43.252, -126.453],
      ])
    ).toBe('_p~iF~ps|U_ulLnnqC_mqNvxq`@')
  })

  it('decodes what it encodes', () => {
    expect(decode('_p~iF~ps|U_ulLnnqC_mqNvxq`@')).toEqual([
      [38.5, -120.2],
      [40.7, -120.95],
      [43.252, -126.453],
    ])
    expect(decode('')).toEqual([])
  })

  it('drops the points of a straight line, keeps the corners', () => {
    const line = Array.from({ length: 100 }, (_, i) => [48.8 + i * 0.0001, 2.3] as const)
    const corner = [...line, ...line.map(([lat]) => [48.8099, 2.3 + (lat - 48.8)] as const)]
    expect(simplify(line)).toEqual([line[0], line[99]])
    expect(simplify(corner)).toHaveLength(3)
  })
})
