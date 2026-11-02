import { Duration, Effect, Random, Ref, Schema } from 'effect'
import { type Cookies, HttpClient, HttpClientRequest, type HttpClientResponse } from 'effect/http'

import { GarminError, LoginRefused, NotLoggedIn, RateLimited } from './errors.ts'

// Garmin's SSO, as Garmin Connect's mobile app does it (garminconnect 0.3.7's, in Python, was the
// reference): the email and password POSTed as JSON, then the MFA code Garmin sends, give a CAS
// service ticket; diauth.garmin.com trades it for an OAuth2 access token (a JWT, about a day) and
// its refresh token. The API (api.ts) takes the access token as a bearer; refresh() renews it.
//
// Two flows, tried in order: the iOS app's (JSON, no page to load), then the web portal's (its
// sign-in page first, then a pause, as Cloudflare flags a GET quickly followed by a POST). Only a
// refusal stops at the first: a rate limit or a challenge on one may not be on the other.

const SSO = 'https://sso.garmin.com'
const DI_TOKEN_URL = 'https://diauth.garmin.com/di-oauth2-service/oauth/token'
const DI_GRANT_TYPE = 'https://connectapi.garmin.com/di-oauth2-service/oauth/grant/service_ticket'
// The mobile app's DI clients, newest first: the first diauth accepts is kept
const DI_CLIENT_IDS = [
  'GARMIN_CONNECT_MOBILE_ANDROID_DI_2025Q2',
  'GARMIN_CONNECT_MOBILE_ANDROID_DI_2024Q4',
  'GARMIN_CONNECT_MOBILE_ANDROID_DI',
  'GARMIN_CONNECT_MOBILE_IOS_DI',
]

const IOS_USER_AGENT =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148'
const DESKTOP_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

type Flow = 'mobile' | 'portal'

const FLOWS = {
  mobile: { clientId: 'GCM_IOS_DARK', service: 'https://mobile.integration.garmin.com/gcm/ios' },
  portal: { clientId: 'GarminConnect', service: 'https://connect.garmin.com/app' },
} as const

const params = (flow: Flow) => ({
  clientId: FLOWS[flow].clientId,
  locale: 'en-US',
  service: FLOWS[flow].service,
})

const signInUrl = `${SSO}/portal/sso/en-US/sign-in`

const postHeaders = (flow: Flow): Record<string, string> =>
  flow === 'mobile'
    ? {
        'user-agent': IOS_USER_AGENT,
        accept: 'application/json, text/plain, */*',
        origin: SSO,
      }
    : {
        'user-agent': DESKTOP_USER_AGENT,
        accept: 'application/json, text/plain, */*',
        'accept-language': 'en-US,en;q=0.9',
        origin: SSO,
        referer: `${signInUrl}?clientId=${FLOWS.portal.clientId}&service=${FLOWS.portal.service}`,
      }

// The headers of Garmin Connect's Android app, on every call to diauth and to the API
export const nativeHeaders = (extra: Record<string, string> = {}): Record<string, string> => ({
  'user-agent': 'GCM-Android-5.23',
  'x-garmin-user-agent':
    'com.garmin.android.apps.connectmobile/5.23; ; Google/sdk_gphone64_arm64/google; Android/33; Dalvik/2.1.0',
  'x-garmin-paired-app-version': '10861',
  'x-garmin-client-platform': 'Android',
  'x-app-ver': '10861',
  'x-lang': 'en',
  'x-gcexperience': 'GC5',
  'accept-language': 'en-US,en;q=0.9',
  ...extra,
})

// The session: garminconnect's garmin_tokens.json, field for field
export const TokensJson = Schema.Struct({
  di_token: Schema.String,
  di_refresh_token: Schema.NullOr(Schema.String),
  di_client_id: Schema.String,
})
export type Tokens = typeof TokensJson.Type

// A JWT's claims, unverified (only read for its expiry and client id)
const claims = (token: string): Record<string, unknown> => {
  const payload = token.split('.')[1]
  if (payload === undefined) return {}
  try {
    const parsed: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

// When the access token expires, null when it does not say
export const expiresAt = (token: string): Date | null => {
  const exp = claims(token)['exp']
  return typeof exp === 'number' ? new Date(exp * 1000) : null
}

// Refreshed 15 minutes before it expires
export const expiresSoon = (tokens: Tokens, now: Date) => {
  const expiry = expiresAt(tokens.di_token)
  return expiry !== null && expiry.getTime() - now.getTime() < 15 * 60 * 1000
}

const clientIdOf = (token: string) => {
  const id = claims(token)['client_id']
  return typeof id === 'string' && id !== '' ? id : null
}

// Mid-login, waiting for the MFA code: the SSO's cookies and which flow asked for it
export interface PendingMfa {
  readonly flow: Flow
  readonly method: string
  readonly cookies: Ref.Ref<ReadonlyArray<Cookies.Cookie>>
}

export type LoginStep =
  | { readonly _tag: 'LoggedIn'; readonly tokens: Tokens }
  | { readonly _tag: 'NeedsMfa'; readonly mfa: PendingMfa }

const SsoAnswerJson = Schema.Struct({
  responseStatus: Schema.optional(Schema.NullOr(Schema.Struct({ type: Schema.String }))),
  serviceTicketId: Schema.optional(Schema.NullOr(Schema.String)),
  customerMfaInfo: Schema.optional(
    Schema.NullOr(
      Schema.Struct({ mfaLastMethodUsed: Schema.optional(Schema.NullOr(Schema.String)) })
    )
  ),
  error: Schema.optional(
    Schema.NullOr(Schema.Struct({ 'status-code': Schema.optional(Schema.String) }))
  ),
})
type SsoAnswer = typeof SsoAnswerJson.Type

const decodeAnswer = Schema.decodeUnknownOption(SsoAnswerJson)

const transport =
  (what: string) =>
  (error: { readonly message: string }): GarminError =>
    new GarminError({ message: `${what}: ${error.message}` })

// The SSO's JSON answer: a rate limit, a challenge or a page that is not JSON fail here
const ssoJson = (what: string, response: HttpClientResponse.HttpClientResponse) =>
  Effect.gen(function* () {
    if (response.status === 429) {
      return yield* new RateLimited({ message: `${what}: Garmin is rate limiting (HTTP 429)` })
    }
    if (response.status === 403) {
      return yield* new GarminError({
        message: `${what}: blocked by Cloudflare (HTTP 403)`,
        status: 403,
      })
    }
    const json = yield* response.json.pipe(
      Effect.mapError(
        () =>
          new GarminError({
            message: `${what}: not JSON (HTTP ${response.status})`,
            status: response.status,
          })
      )
    )
    const answer = decodeAnswer(json)
    if (answer._tag === 'None') {
      return yield* new GarminError({
        message: `${what}: unexpected answer (HTTP ${response.status})`,
      })
    }
    if (answer.value.error?.['status-code'] === '429') {
      return yield* new RateLimited({ message: `${what}: Garmin is rate limiting` })
    }
    return answer.value
  })

const withCookies = (cookies: Ref.Ref<ReadonlyArray<Cookies.Cookie>>) =>
  Effect.map(HttpClient.HttpClient, (client) =>
    client.pipe(HttpClient.followRedirects(5), HttpClient.withCookiesRef(cookies))
  )

const post = (
  cookies: Ref.Ref<ReadonlyArray<Cookies.Cookie>>,
  what: string,
  url: string,
  flow: Flow,
  body: unknown
) =>
  Effect.gen(function* () {
    const client = yield* withCookies(cookies)
    const response = yield* client
      .execute(
        HttpClientRequest.post(url).pipe(
          HttpClientRequest.setUrlParams(params(flow)),
          HttpClientRequest.setHeaders(postHeaders(flow)),
          HttpClientRequest.bodyJsonUnsafe(body)
        )
      )
      .pipe(
        Effect.mapError(transport(what)),
        Effect.timeoutOrElse({
          duration: '30 seconds',
          orElse: () => Effect.fail(new GarminError({ message: `${what}: no answer in 30 s` })),
        })
      )
    return yield* ssoJson(what, response)
  })

// Trades a CAS service ticket for the DI tokens
export const exchangeTicket = (ticket: string, flow: Flow) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    for (const clientId of DI_CLIENT_IDS) {
      const response = yield* client
        .execute(
          HttpClientRequest.post(DI_TOKEN_URL).pipe(
            HttpClientRequest.setHeaders(
              nativeHeaders({
                authorization: `Basic ${Buffer.from(`${clientId}:`).toString('base64')}`,
                accept: 'application/json,text/html;q=0.9,*/*;q=0.8',
                'cache-control': 'no-cache',
              })
            ),
            HttpClientRequest.bodyUrlParams({
              client_id: clientId,
              service_ticket: ticket,
              grant_type: DI_GRANT_TYPE,
              service_url: FLOWS[flow].service,
            })
          )
        )
        .pipe(Effect.mapError(transport('token exchange')))
      if (response.status === 429) {
        return yield* new RateLimited({ message: 'token exchange: Garmin is rate limiting' })
      }
      if (response.status < 200 || response.status >= 300) continue
      const tokens = yield* tokensOf(response, clientId, null).pipe(Effect.option)
      if (tokens._tag === 'Some') return tokens.value
    }
    return yield* new GarminError({ message: 'token exchange: refused for every DI client id' })
  })

const TokenAnswer = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.optional(Schema.NullOr(Schema.String)),
})

const tokensOf = (
  response: HttpClientResponse.HttpClientResponse,
  clientId: string,
  previousRefresh: string | null
) =>
  response.json.pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(TokenAnswer)),
    Effect.map((answer): Tokens => ({
      di_token: answer.access_token,
      di_refresh_token: answer.refresh_token ?? previousRefresh,
      di_client_id: clientIdOf(answer.access_token) ?? clientId,
    })),
    Effect.mapError(() => new GarminError({ message: 'token answer without an access token' }))
  )

// The answer to the email and password, or to the MFA code
const outcome = (what: string, flow: Flow, answer: SsoAnswer) =>
  Effect.gen(function* () {
    const type = answer.responseStatus?.type
    if (type === 'SUCCESSFUL' && typeof answer.serviceTicketId === 'string') {
      return { _tag: 'Ticket' as const, ticket: answer.serviceTicketId }
    }
    if (type === 'MFA_REQUIRED') {
      return {
        _tag: 'Mfa' as const,
        method: answer.customerMfaInfo?.mfaLastMethodUsed ?? 'email',
      }
    }
    if (type === 'INVALID_USERNAME_PASSWORD') {
      return yield* new LoginRefused({ message: 'Garmin refused the email or the password' })
    }
    if (type === 'CAPTCHA_REQUIRED') {
      return yield* new GarminError({ message: `${what} (${flow}): Garmin asks for a captcha` })
    }
    if (type === 'ACCOUNT_LOCKED') {
      return yield* new LoginRefused({ message: 'Garmin says the account is locked' })
    }
    return yield* new GarminError({ message: `${what} (${flow}): unexpected answer ${type ?? ''}` })
  })

const credentials = (email: string, password: string) => ({
  username: email,
  password,
  rememberMe: true,
  captchaToken: '',
})

const loginWith = (flow: Flow, email: string, password: string, portalDelay: Duration.Input) =>
  Effect.gen(function* () {
    const cookies = yield* Ref.make<ReadonlyArray<Cookies.Cookie>>([])
    if (flow === 'portal') {
      // The sign-in page, for its cookies, then a person's pause before the POST
      const client = yield* withCookies(cookies)
      const page = yield* client
        .execute(
          HttpClientRequest.get(signInUrl).pipe(
            HttpClientRequest.setUrlParams({
              clientId: FLOWS.portal.clientId,
              service: FLOWS.portal.service,
            }),
            HttpClientRequest.setHeaders({
              'user-agent': DESKTOP_USER_AGENT,
              accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
              'accept-language': 'en-US,en;q=0.9',
            })
          )
        )
        .pipe(Effect.mapError(transport('sign-in page')))
      if (page.status === 429) {
        return yield* new RateLimited({ message: 'sign-in page: Garmin is rate limiting' })
      }
      const jitter = yield* Random.next
      yield* Effect.sleep(Duration.times(Duration.fromInputUnsafe(portalDelay), 1 + jitter))
    }
    const answer = yield* post(
      cookies,
      'login',
      `${SSO}/${flow}/api/login`,
      flow,
      credentials(email, password)
    )
    const next = yield* outcome('login', flow, answer)
    if (next._tag === 'Mfa') {
      const step: LoginStep = { _tag: 'NeedsMfa', mfa: { flow, method: next.method, cookies } }
      return step
    }
    const tokens = yield* exchangeTicket(next.ticket, flow)
    const step: LoginStep = { _tag: 'LoggedIn', tokens }
    return step
  })

// The email and password: tokens, or the MFA code to ask for (verifyMfa). portalDelay: the
// pause of the portal's flow, doubled at most (10 s by default; tests set 0)
export const login = (
  email: string,
  password: string,
  options: { readonly portalDelay?: Duration.Input } = {}
) =>
  loginWith('mobile', email, password, 0).pipe(
    Effect.catchTags({
      RateLimited: (first) =>
        loginWith('portal', email, password, options.portalDelay ?? '10 seconds').pipe(
          Effect.mapError((second) =>
            second._tag === 'GarminError'
              ? new GarminError({ message: `${first.message}; then ${second.message}` })
              : second
          )
        ),
      GarminError: (first) =>
        loginWith('portal', email, password, options.portalDelay ?? '10 seconds').pipe(
          Effect.mapError((second) =>
            second._tag === 'LoginRefused'
              ? second
              : new GarminError({ message: `${first.message}; then ${second.message}` })
          )
        ),
    }),
    Effect.withSpan('Garmin.login')
  )

// The MFA code (Garmin's email or app): its flow's endpoint, then the other's (both share the
// SSO's cookies, and may not share a rate limit)
export const verifyMfa = (mfa: PendingMfa, code: string) =>
  Effect.gen(function* () {
    const other: Flow = mfa.flow === 'mobile' ? 'portal' : 'mobile'
    const failures: Array<RateLimited | GarminError> = []
    for (const flow of [mfa.flow, other]) {
      const answer = yield* post(mfa.cookies, 'MFA', `${SSO}/${flow}/api/mfa/verifyCode`, flow, {
        mfaMethod: mfa.method,
        mfaVerificationCode: code.trim(),
        rememberMyBrowser: true,
        reconsentList: [],
        mfaSetup: false,
      }).pipe(Effect.result)
      if (answer._tag === 'Failure') {
        failures.push(answer.failure)
        continue
      }
      if (answer.success.responseStatus?.type === 'SUCCESSFUL' && answer.success.serviceTicketId) {
        // The ticket is for the service of the flow that logged in
        return yield* exchangeTicket(answer.success.serviceTicketId, mfa.flow)
      }
      return yield* new LoginRefused({ message: 'Garmin refused the MFA code' })
    }
    if (failures.every((failure) => failure._tag === 'RateLimited')) {
      return yield* new RateLimited({ message: 'MFA: Garmin is rate limiting' })
    }
    return yield* new GarminError({
      message: `MFA: ${failures.map((failure) => failure.message).join('; ')}`,
    })
  }).pipe(Effect.withSpan('Garmin.verifyMfa'))

// A new access token from the refresh token; NotLoggedIn once Garmin refuses it
export const refresh = (tokens: Tokens) =>
  Effect.gen(function* () {
    if (tokens.di_refresh_token === null) {
      return yield* new NotLoggedIn({ message: 'the session has no refresh token' })
    }
    const client = yield* HttpClient.HttpClient
    const response = yield* client
      .execute(
        HttpClientRequest.post(DI_TOKEN_URL).pipe(
          HttpClientRequest.setHeaders(
            nativeHeaders({
              authorization: `Basic ${Buffer.from(`${tokens.di_client_id}:`).toString('base64')}`,
              accept: 'application/json',
              'cache-control': 'no-cache',
            })
          ),
          HttpClientRequest.bodyUrlParams({
            grant_type: 'refresh_token',
            client_id: tokens.di_client_id,
            refresh_token: tokens.di_refresh_token,
          })
        )
      )
      .pipe(Effect.mapError(transport('token refresh')))
    if (response.status === 429) {
      return yield* new RateLimited({ message: 'token refresh: Garmin is rate limiting' })
    }
    if (response.status === 400 || response.status === 401 || response.status === 403) {
      return yield* new NotLoggedIn({
        message: `Garmin refused to refresh the session (HTTP ${response.status})`,
      })
    }
    if (response.status < 200 || response.status >= 300) {
      return yield* new GarminError({
        message: `token refresh: HTTP ${response.status}`,
        status: response.status,
      })
    }
    return yield* tokensOf(response, tokens.di_client_id, tokens.di_refresh_token)
  }).pipe(Effect.withSpan('Garmin.refresh'))
