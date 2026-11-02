import { expect, it } from '@effect/vitest'
import { Effect } from 'effect'
import { HttpClientRequest, HttpClientResponse } from 'effect/http'

import { body, json } from './body.ts'

const answer = (content: string) =>
  HttpClientResponse.fromWeb(HttpClientRequest.get('https://example.com/'), new Response(content))

it.effect('reads a body up to its cap, and refuses one past it', () =>
  Effect.gen(function* () {
    expect(yield* json('ok', answer('{"a":1}'))).toEqual({ a: 1 })
    expect(new TextDecoder().decode(yield* body('ok', answer('1234'), 4))).toBe('1234')
    const error = yield* body('big', answer('12345'), 4).pipe(Effect.flip)
    expect(error.message).toBe('big: over 4 bytes')
  })
)
