import { Context, Effect, Layer, Schedule, Schema } from 'effect'
import { HttpClient, HttpClientRequest, type HttpClientResponse } from 'effect/http'

import { body, text } from './body.ts'
import { GarminError, NotLoggedIn, RateLimited } from './errors.ts'
import { type Account, GarminSession, LOGIN_HINT } from './session.ts'
import { nativeHeaders } from './sso.ts'

// Garmin Connect's API (connectapi.garmin.com), as its mobile app calls it: the session's access
// token as a bearer (refreshed before it expires, and once more on a 401). Read-only: the app
// never writes to Garmin.

const CONNECT_API = 'https://connectapi.garmin.com'

type Params = Readonly<Record<string, string | number>>

export type ApiFailure = NotLoggedIn | RateLimited | GarminError

const Profile = Schema.Struct({
  displayName: Schema.String,
  fullName: Schema.optional(Schema.NullOr(Schema.String)),
})

export class GarminApi extends Context.Service<
  GarminApi,
  {
    // JSON, null for an empty answer (204)
    readonly json: (path: string, params?: Params) => Effect.Effect<unknown, ApiFailure>
    readonly bytes: (path: string) => Effect.Effect<Uint8Array, ApiFailure>
    // Who the session is (its displayName is in several endpoints' paths)
    readonly profile: Effect.Effect<Account, ApiFailure>
  }
>()('garmin/GarminApi') {
  static readonly layer = Layer.effect(
    GarminApi,
    Effect.gen(function* () {
      const session = yield* GarminSession
      const client = (yield* HttpClient.HttpClient).pipe(
        HttpClient.retryTransient({
          schedule: Schedule.exponential('1 second'),
          times: 2,
        })
      )

      const send = (path: string, params: Params, accept: string, token: string) =>
        client
          .execute(
            HttpClientRequest.get(`${CONNECT_API}/${path.replace(/^\//u, '')}`).pipe(
              HttpClientRequest.setUrlParams(
                Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)]))
              ),
              HttpClientRequest.setHeaders(
                nativeHeaders({ authorization: `Bearer ${token}`, accept })
              )
            )
          )
          .pipe(
            Effect.timeoutOrElse({
              duration: '60 seconds',
              orElse: () => Effect.fail(new GarminError({ message: `${path}: no answer in 60 s` })),
            }),
            Effect.mapError((error) =>
              error._tag === 'GarminError'
                ? error
                : new GarminError({ message: `${path}: ${error.message}` })
            )
          )

      // The answer, once more with a refreshed token after a 401
      const request = (path: string, params: Params, accept: string) =>
        Effect.gen(function* () {
          const token = yield* session.accessToken()
          let response = yield* send(path, params, accept, token)
          if (response.status === 401) {
            const fresh = yield* session.accessToken({ rejected: token })
            response = yield* send(path, params, accept, fresh)
          }
          return yield* checked(path, response)
        })

      const checked = (path: string, response: HttpClientResponse.HttpClientResponse) =>
        Effect.gen(function* () {
          if (response.status === 401 || response.status === 403) {
            return yield* new NotLoggedIn({
              message: `Garmin refused the session (HTTP ${response.status} on ${path}): ${LOGIN_HINT}`,
            })
          }
          if (response.status === 429) {
            return yield* new RateLimited({
              message: `${path}: Garmin is rate limiting (HTTP 429)`,
            })
          }
          if (response.status >= 400) {
            const detail = yield* text(path, response).pipe(Effect.orElseSucceed(() => ''))
            return yield* new GarminError({
              message: `${path}: HTTP ${response.status}${detail.length > 0 && detail.length < 300 ? ` ${detail}` : ''}`,
              status: response.status,
            })
          }
          return response
        })

      const json = (path: string, params: Params = {}) =>
        request(path, params, 'application/json').pipe(
          Effect.flatMap((response) =>
            response.status === 204
              ? Effect.succeed(null)
              : text(path, response).pipe(
                  Effect.flatMap((content) =>
                    Effect.try({
                      try: (): unknown => (content.trim() === '' ? null : JSON.parse(content)),
                      catch: () => new GarminError({ message: `${path}: not JSON` }),
                    })
                  )
                )
          ),
          Effect.withSpan('GarminApi.json', { attributes: { path } })
        )

      const bytes = (path: string) =>
        request(path, {}, '*/*').pipe(
          Effect.flatMap((response) => body(path, response)),
          Effect.withSpan('GarminApi.bytes', { attributes: { path } })
        )

      const profile = json('/userprofile-service/socialProfile').pipe(
        Effect.flatMap((body) =>
          Schema.decodeUnknownEffect(Profile)(body).pipe(
            Effect.mapError(() => new GarminError({ message: 'the profile has no displayName' }))
          )
        ),
        Effect.map((profile): Account => ({
          display_name: profile.displayName,
          full_name: profile.fullName ?? null,
        }))
      )

      return GarminApi.of({ json, bytes, profile })
    })
  )
}
