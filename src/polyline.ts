// A route for maps: simplified (Douglas-Peucker) then encoded as a Google polyline (precision 5,
// what Leaflet and MapLibre plugins decode)

export type Point = readonly [lat: number, lon: number]

// Metres on a local plane around the route: within a route, the error is negligible
const projector = (points: ReadonlyArray<Point>) => {
  const lat0 = ((points[0]?.[0] ?? 0) * Math.PI) / 180
  const metresPerDegree = 111_320
  return ([lat, lon]: Point) =>
    [lon * metresPerDegree * Math.cos(lat0), lat * metresPerDegree] as const
}

// Distance from p to the segment a-b, all projected
const segmentDistance = (
  p: readonly [number, number],
  a: readonly [number, number],
  b: readonly [number, number]
) => {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const length = dx * dx + dy * dy
  const t =
    length === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length))
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy))
}

// Keeps the points the route cannot lose without moving more than `tolerance` metres. Iterative:
// a long activity's thousands of points would overflow a recursion.
export const simplify = (points: ReadonlyArray<Point>, tolerance = 5): Array<Point> => {
  if (points.length < 3) return [...points]
  const project = projector(points)
  const projected = points.map((point) => project(point))
  const keep = new Uint8Array(points.length)
  keep[0] = 1
  keep[points.length - 1] = 1
  const stack: Array<readonly [number, number]> = [[0, points.length - 1]]
  for (let span = stack.pop(); span !== undefined; span = stack.pop()) {
    const [first, last] = span
    let farthest = -1
    let distance = tolerance
    for (let index = first + 1; index < last; index += 1) {
      const point = projected[index]
      const a = projected[first]
      const b = projected[last]
      if (point === undefined || a === undefined || b === undefined) continue
      const d = segmentDistance(point, a, b)
      if (d > distance) {
        farthest = index
        distance = d
      }
    }
    if (farthest !== -1) {
      keep[farthest] = 1
      stack.push([first, farthest], [farthest, last])
    }
  }
  return points.filter((_, index) => keep[index] === 1)
}

const encodeValue = (value: number) => {
  let rest = value < 0 ? ~(value << 1) : value << 1
  let encoded = ''
  while (rest >= 0x20) {
    encoded += String.fromCodePoint((0x20 | (rest & 0x1f)) + 63)
    rest >>= 5
  }
  return encoded + String.fromCodePoint(rest + 63)
}

export const encode = (points: ReadonlyArray<Point>) => {
  let previousLat = 0
  let previousLon = 0
  let encoded = ''
  for (const [lat, lon] of points) {
    const latE5 = Math.round(lat * 1e5)
    const lonE5 = Math.round(lon * 1e5)
    encoded += encodeValue(latE5 - previousLat) + encodeValue(lonE5 - previousLon)
    previousLat = latE5
    previousLon = lonE5
  }
  return encoded
}

// The route back from its polyline (the web page draws it)
export const decode = (encoded: string): Array<Point> => {
  const points: Array<Point> = []
  let index = 0
  let lat = 0
  let lon = 0
  const next = () => {
    let shift = 0
    let result = 0
    let byte = 0x20
    while (byte >= 0x20 && index < encoded.length) {
      byte = (encoded.codePointAt(index) ?? 63) - 63
      index += 1
      result |= (byte & 0x1f) << shift
      shift += 5
    }
    return result & 1 ? ~(result >> 1) : result >> 1
  }
  while (index < encoded.length) {
    lat += next()
    lon += next()
    points.push([lat / 1e5, lon / 1e5])
  }
  return points
}
