import { expect, it } from '@effect/vitest'
import { Effect } from 'effect'
import { describe } from 'vitest'

import { fakeGarmin, inHours, json, jwt } from '../../test/garmin.ts'

import { expiresSoon, login, refresh, verifyMfa } from './sso.ts'

const access = jwt({ exp: inHours(20), client_id: 'GARMIN_CONNECT_MOBILE_ANDROID_DI_2024Q4' })

// diauth: the first client id refused, the second accepted
const diauth = (body: string) => {
  const form = new URLSearchParams(body)
  if (form.get('client_id') === 'GARMIN_CONNECT_MOBILE_ANDROID_DI_2025Q2') {
    return new Response('nope', { status: 400 })
  }
  return json({ access_token: access, refresh_token: 'refresh-1' })
}

describe('Garmin SSO', () => {
  it.effect('logs in with the MFA code, the SSO cookies kept between the two steps', () =>
    Effect.gen(function* () {
      const garmin = fakeGarmin(({ url, body, headers }) => {
        if (url.pathname === '/mobile/api/login') {
          expect(JSON.parse(body)).toMatchObject({ username: 'v@example.com', password: 'secret' })
          expect(url.searchParams.get('clientId')).toBe('GCM_IOS_DARK')
          return json(
            {
              responseStatus: { type: 'MFA_REQUIRED' },
              customerMfaInfo: { mfaLastMethodUsed: 'email' },
            },
            { headers: { 'set-cookie': 'SESSION=sso-cookie; Path=/; Secure' } }
          )
        }
        if (url.pathname === '/mobile/api/mfa/verifyCode') {
          expect(headers['cookie']).toContain('SESSION=sso-cookie')
          expect(JSON.parse(body)).toMatchObject({
            mfaMethod: 'email',
            mfaVerificationCode: '123456',
          })
          return json({ responseStatus: { type: 'SUCCESSFUL' }, serviceTicketId: 'ST-1' })
        }
        if (url.host === 'diauth.garmin.com') {
          const form = new URLSearchParams(body)
          expect(form.get('service_ticket')).toBe('ST-1')
          expect(form.get('service_url')).toBe('https://mobile.integration.garmin.com/gcm/ios')
          return diauth(body)
        }
        return new Response('unexpected', { status: 500 })
      })
      const step = yield* login('v@example.com', 'secret').pipe(Effect.provide(garmin.layer))
      if (step._tag !== 'NeedsMfa') throw new Error('expected the MFA step')
      const tokens = yield* verifyMfa(step.mfa, ' 123456 ').pipe(Effect.provide(garmin.layer))
      expect(tokens).toEqual({
        di_token: access,
        di_refresh_token: 'refresh-1',
        di_client_id: 'GARMIN_CONNECT_MOBILE_ANDROID_DI_2024Q4',
      })
    })
  )

  it.effect('stops at a wrong password, without trying the portal', () =>
    Effect.gen(function* () {
      const garmin = fakeGarmin(() =>
        json({ responseStatus: { type: 'INVALID_USERNAME_PASSWORD' } }, { status: 401 })
      )
      const error = yield* login('v@example.com', 'wrong').pipe(
        Effect.flip,
        Effect.provide(garmin.layer)
      )
      expect(error._tag).toBe('LoginRefused')
      expect(garmin.log).toHaveLength(1)
    })
  )

  it.effect("falls back to the portal's flow when the mobile one is rate limited", () =>
    Effect.gen(function* () {
      const garmin = fakeGarmin(({ url, body }) => {
        if (url.pathname === '/mobile/api/login') return json({}, { status: 429 })
        if (url.pathname === '/portal/sso/en-US/sign-in') return new Response('<html></html>')
        if (url.pathname === '/portal/api/login') {
          return json({ responseStatus: { type: 'SUCCESSFUL' }, serviceTicketId: 'ST-2' })
        }
        if (url.host === 'diauth.garmin.com') {
          expect(new URLSearchParams(body).get('service_url')).toBe(
            'https://connect.garmin.com/app'
          )
          return diauth(body)
        }
        return new Response('unexpected', { status: 500 })
      })
      const step = yield* login('v@example.com', 'secret', { portalDelay: 0 }).pipe(
        Effect.provide(garmin.layer)
      )
      expect(step._tag).toBe('LoggedIn')
      expect(garmin.log.map((r) => r.url.pathname)).toEqual([
        '/mobile/api/login',
        '/portal/sso/en-US/sign-in',
        '/portal/api/login',
        '/di-oauth2-service/oauth/token',
        '/di-oauth2-service/oauth/token',
      ])
    })
  )

  it.effect('refreshes the access token, and says logged out once Garmin refuses', () =>
    Effect.gen(function* () {
      const tokens = { di_token: access, di_refresh_token: 'refresh-1', di_client_id: 'client' }
      const fresh = jwt({ exp: inHours(24), client_id: 'client' })
      const ok = fakeGarmin(({ body }) => {
        const form = new URLSearchParams(body)
        expect(form.get('grant_type')).toBe('refresh_token')
        expect(form.get('refresh_token')).toBe('refresh-1')
        return json({ access_token: fresh })
      })
      expect(yield* refresh(tokens).pipe(Effect.provide(ok.layer))).toEqual({
        di_token: fresh,
        di_refresh_token: 'refresh-1',
        di_client_id: 'client',
      })
      const refused = fakeGarmin(() => json({ error: 'invalid_grant' }, { status: 400 }))
      const error = yield* refresh(tokens).pipe(Effect.flip, Effect.provide(refused.layer))
      expect(error._tag).toBe('NotLoggedIn')
    })
  )

  it('refreshes 15 minutes before the expiry', () => {
    const now = new Date()
    const at = (minutes: number) => ({
      di_token: jwt({ exp: Math.floor(now.getTime() / 1000) + minutes * 60 }),
      di_refresh_token: null,
      di_client_id: 'client',
    })
    expect(expiresSoon(at(10), now)).toBe(true)
    expect(expiresSoon(at(20), now)).toBe(false)
  })
})
