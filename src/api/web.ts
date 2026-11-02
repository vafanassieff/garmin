import { Effect, Schema } from 'effect'

import { explain, GarminLogin } from '../garmin/login.ts'
import { GarminSync } from '../garmin/sync.ts'
import { type GrantView, OAuth } from '../oauth/oauth.ts'
import { Stats } from '../stats.ts'

import { base, standard } from './base.ts'
import { RUNS_SPANS, SLEEP_PERIODS } from './periods.ts'

// The web pages' calls (RPC only, behind the web session): their loaders and buttons, through the
// typed client (client.ts)

export interface SyncRunView {
  readonly started_at: string
  readonly finished_at: string | null
  readonly ok: boolean | null
  readonly logged_out: boolean
  readonly account: string | null
  readonly files_written: number | null
  readonly warnings: ReadonlyArray<string>
  readonly error: string | null
}

export interface GarminView {
  readonly session: {
    readonly logged_in: boolean
    readonly account: { readonly display_name: string; readonly full_name: string | null } | null
    readonly expires_at: string | null
    readonly saved_at: string | null
    readonly refreshable: boolean
  }
  readonly syncing: boolean
  // The whole history asked and not fetched yet (see sync.ts)
  readonly backfilling: boolean
  readonly runs: ReadonlyArray<SyncRunView>
}

export type LoginAnswer =
  | { readonly status: 'logged_in'; readonly account: string }
  | { readonly status: 'mfa'; readonly id: string; readonly method: string }
  | { readonly status: 'error'; readonly message: string }

export interface AccessView {
  // The MCP's URL, to give to a client
  readonly mcp: string
  readonly grants: ReadonlyArray<GrantView>
}

const garminView = Effect.gen(function* () {
  const login = yield* GarminLogin
  const sync = yield* GarminSync
  const runs = yield* sync.recent(8).pipe(Effect.orElseSucceed(() => []))
  return {
    session: yield* login.status,
    syncing: yield* sync.running,
    backfilling: yield* sync.backfilling,
    runs: runs.map((run) => ({
      started_at: run.started_at,
      finished_at: run.finished_at,
      ok: run.ok,
      logged_out: run.logged_out,
      account: run.account,
      files_written: run.files_written,
      warnings: run.warnings === null ? [] : (JSON.parse(run.warnings) as Array<string>),
      error: run.error,
    })),
  } satisfies GarminView
})

const Text = (max: number) => Schema.String.check(Schema.isMaxLength(max))

export const web = {
  dashboard: base.handler(({ context }) =>
    context.run(
      Effect.gen(function* () {
        const stats = yield* Stats
        return { dashboard: yield* stats.dashboard, garmin: yield* garminView }
      })
    )
  ),

  garmin: base.handler(({ context }) => context.run(garminView)),

  garminLogin: base
    .input(standard(Schema.Struct({ email: Text(512), password: Text(512) })))
    .handler(({ input, context }) =>
      context.run(
        GarminLogin.use((login) => login.start(input)).pipe(
          Effect.map((step): LoginAnswer =>
            step._tag === 'LoggedIn'
              ? {
                  status: 'logged_in',
                  account: step.account.full_name ?? step.account.display_name,
                }
              : { status: 'mfa', id: step.id, method: step.method }
          ),
          Effect.catch((error) =>
            Effect.succeed<LoginAnswer>({ status: 'error', message: explain(error) })
          )
        )
      )
    ),

  garminMfa: base
    .input(standard(Schema.Struct({ id: Text(64), code: Text(16) })))
    .handler(({ input, context }) =>
      context.run(
        GarminLogin.use((login) => login.mfa(input.id, input.code)).pipe(
          Effect.map((account): LoginAnswer => ({
            status: 'logged_in',
            account: account.full_name ?? account.display_name,
          })),
          Effect.catch((error) =>
            Effect.succeed<LoginAnswer>({ status: 'error', message: explain(error) })
          )
        )
      )
    ),

  garminLogout: base.handler(({ context }) =>
    context.run(GarminLogin.use((login) => login.logout))
  ),

  syncNow: base.handler(({ context }) => context.run(GarminSync.use((sync) => sync.trigger))),

  // The whole history, from the oldest activity: in the background, resumed until it completes
  backfill: base.handler(({ context }) => context.run(GarminSync.use((sync) => sync.backfill))),

  runs: base
    .input(standard(Schema.Struct({ span: Schema.Literals(RUNS_SPANS) })))
    .handler(({ input, context }) => context.run(Stats.use((stats) => stats.runs(input.span)))),

  // Every activity, of one sport when asked (a Connect type: letters and underscores)
  activities: base
    .input(
      standard(
        Schema.Struct({
          sport: Schema.NullOr(Schema.String.check(Schema.isPattern(/^[a-z_]{1,40}$/u))),
        })
      )
    )
    .handler(({ input, context }) =>
      context.run(Stats.use((stats) => stats.activities(input.sport)))
    ),

  activity: base
    .input(standard(Schema.Struct({ id: Schema.Int.check(Schema.isGreaterThan(0)) })))
    .handler(({ input, context }) => context.run(Stats.use((stats) => stats.activity(input.id)))),

  sleep: base
    .input(standard(Schema.Struct({ days: Schema.Literals(SLEEP_PERIODS) })))
    .handler(({ input, context }) => context.run(Stats.use((stats) => stats.sleep(input.days)))),

  // The applications allowed on the MCP through OAuth (see oauth/oauth.ts)
  access: base.handler(({ context }) =>
    context.run(
      Effect.map(
        OAuth.use((oauth) => oauth.grants),
        (grants): AccessView => ({ mcp: `${context.origin}/mcp`, grants })
      )
    )
  ),

  revokeAccess: base
    .input(standard(Schema.Struct({ id: Text(64) })))
    .handler(({ input, context }) =>
      context.run(OAuth.use((oauth) => oauth.revokeGrant(input.id)))
    ),
}
