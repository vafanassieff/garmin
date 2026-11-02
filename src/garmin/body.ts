import { Effect, Stream } from 'effect'
import type { HttpClientResponse } from 'effect/http'

import { GarminError } from './errors.ts'

// An answer's body at most: a page of activities or a day's file is well under a MB, a FIT zip a
// few (a bigger one would only fill the memory)
export const MAX_BODY = 64 * 1024 * 1024

// The body, refused past `max` bytes as it arrives
export const body = (
  what: string,
  response: HttpClientResponse.HttpClientResponse,
  max = MAX_BODY
) =>
  Stream.runFoldEffect(
    response.stream,
    () => ({ chunks: [] as Array<Uint8Array>, size: 0 }),
    (read, chunk) => {
      read.size += chunk.length
      if (read.size > max) {
        return Effect.fail(new GarminError({ message: `${what}: over ${max} bytes` }))
      }
      read.chunks.push(chunk)
      return Effect.succeed(read)
    }
  ).pipe(
    Effect.map(({ chunks }) => new Uint8Array(Buffer.concat(chunks))),
    Effect.mapError((error) =>
      error._tag === 'GarminError'
        ? error
        : new GarminError({ message: `${what}: ${error.message}` })
    )
  )

// The body as text
export const text = (what: string, response: HttpClientResponse.HttpClientResponse) =>
  Effect.map(body(what, response), (bytes) => new TextDecoder().decode(bytes))

// The body as JSON
export const json = (what: string, response: HttpClientResponse.HttpClientResponse) =>
  Effect.flatMap(text(what, response), (content) =>
    Effect.try({
      try: (): unknown => JSON.parse(content),
      catch: () => new GarminError({ message: `${what}: not JSON` }),
    })
  )
