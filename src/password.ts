import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'

// The app's password, stored only as `scrypt$<N>$<r>$<p>$<salt>$<key>` (base64): about 100 ms and
// 32 MiB per guess. Chosen in the web app (see auth.ts).
const cost = { N: 2 ** 15, r: 8, p: 1 }

const derive = (password: string, salt: Buffer, length: number, params: typeof cost) =>
  new Promise<Buffer>((resolve, reject) => {
    // 128 × N × r bytes, over Node's 32 MiB default
    scrypt(password, salt, length, { ...params, maxmem: 256 * params.N * params.r }, (error, key) =>
      error === null ? resolve(key) : reject(error)
    )
  })

export const hashPassword = async (password: string) => {
  const salt = randomBytes(16)
  const key = await derive(password, salt, 32, cost)
  return ['scrypt', cost.N, cost.r, cost.p, salt.toString('base64'), key.toString('base64')].join(
    '$'
  )
}

// False for a malformed hash too
export const verifyPassword = async (hash: string, password: string) => {
  const [scheme, N, r, p, salt, key] = hash.split('$')
  if (scheme !== 'scrypt' || salt === undefined || key === undefined) return false
  const expected = Buffer.from(key, 'base64')
  if (expected.length === 0) return false
  const params = { N: Number(N), r: Number(r), p: Number(p) }
  // Parameters scrypt refuses reject
  const actual = await derive(password, Buffer.from(salt, 'base64'), expected.length, params).catch(
    () => undefined
  )
  return actual !== undefined && timingSafeEqual(actual, expected)
}
