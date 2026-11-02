import { expect, it } from 'vitest'

import { hashPassword, verifyPassword } from './password.ts'

it('hashes with scrypt and a fresh salt, and verifies only the same password', async () => {
  const hash = await hashPassword('correct horse')
  expect(hash).toMatch(/^scrypt\$32768\$8\$1\$[A-Za-z0-9+/=]{24}\$[A-Za-z0-9+/=]{44}$/u)
  expect(hash).not.toContain('correct horse')
  expect(await hashPassword('correct horse')).not.toBe(hash)

  expect(await verifyPassword(hash, 'correct horse')).toBe(true)
  expect(await verifyPassword(hash, 'correct horse ')).toBe(false)
  expect(await verifyPassword(hash, '')).toBe(false)
})

it('refuses a malformed hash', async () => {
  const [, , , , salt, key] = (await hashPassword('demo')).split('$')
  for (const hash of [
    '',
    'demo',
    `bcrypt$32768$8$1$${salt}$${key}`,
    `scrypt$3$8$1$${salt}$${key}`,
    `scrypt$32768$8$1$${salt}$`,
  ]) {
    expect(await verifyPassword(hash, 'demo')).toBe(false)
  }
})
