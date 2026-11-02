import { Schema } from 'effect'

// What can go wrong with Garmin. Messages never hold a token, a password nor an MFA code.

// No session, or Garmin refused it (revoked, password changed): log in again
export class NotLoggedIn extends Schema.TaggedError<NotLoggedIn>()('NotLoggedIn', {
  message: Schema.String,
}) {}

// Garmin said no to the email, the password or the MFA code
export class LoginRefused extends Schema.TaggedError<LoginRefused>()('LoginRefused', {
  message: Schema.String,
}) {}

// HTTP 429, or Garmin's rate limit in a JSON body: every next call would fail the same
export class RateLimited extends Schema.TaggedError<RateLimited>()('RateLimited', {
  message: Schema.String,
}) {}

// Anything else: a transport error, an HTTP error, a Cloudflare challenge, an unexpected body
export class GarminError extends Schema.TaggedError<GarminError>()('GarminError', {
  message: Schema.String,
  status: Schema.optional(Schema.Number),
}) {}

export type GarminFailure = NotLoggedIn | LoginRefused | RateLimited | GarminError
