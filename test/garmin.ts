import { Effect, Layer } from 'effect'
import { HttpClient, HttpClientResponse } from 'effect/http'

// A fake Garmin (SSO, diauth, the API) for the tests: every request goes to `handle`, logged

export interface FakeRequest {
  readonly method: string
  readonly url: URL
  readonly headers: Readonly<Record<string, string>>
  readonly body: string
}

const decoder = new TextDecoder()

export const fakeGarmin = (handle: (request: FakeRequest) => Response | Promise<Response>) => {
  const log: Array<FakeRequest> = []
  const client = HttpClient.make((request, url) =>
    Effect.promise(async () => {
      const body = request.body._tag === 'Uint8Array' ? decoder.decode(request.body.body) : ''
      const fake: FakeRequest = { method: request.method, url, headers: request.headers, body }
      log.push(fake)
      return HttpClientResponse.fromWeb(request, await handle(fake))
    })
  )
  return { log, layer: Layer.succeed(HttpClient.HttpClient, client) }
}

export const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    ...init,
    headers: new Headers([
      ['content-type', 'application/json'],
      ...new Headers(init.headers).entries(),
    ]),
  })

// An unsigned JWT with these claims (the app only reads exp and client_id)
export const jwt = (claims: Record<string, unknown>) =>
  [
    Buffer.from('{"alg":"none"}').toString('base64url'),
    Buffer.from(JSON.stringify(claims)).toString('base64url'),
    'signature',
  ].join('.')

export const inHours = (hours: number) => Math.floor(Date.now() / 1000) + hours * 3600
