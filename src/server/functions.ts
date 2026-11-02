import { createServerFn } from '@tanstack/react-start'
import { Effect } from 'effect'

import { explain, GarminLogin } from '../garmin/login.ts'
import { GarminSync } from '../garmin/sync.ts'
import { Stats } from '../stats.ts'

import { runtime } from './runtime.ts'

// The web pages' calls to the app, behind the web session (see auth.ts). Their handlers only run
// on the server: the client bundle gets a fetch in their place, without these imports.

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

export const getGarmin = createServerFn({ method: 'GET' }).handler(() =>
  runtime.runPromise(garminView)
)

export const getDashboard = createServerFn({ method: 'GET' }).handler(() =>
  runtime.runPromise(
    Effect.gen(function* () {
      const stats = yield* Stats
      return { dashboard: yield* stats.dashboard.pipe(Effect.orDie), garmin: yield* garminView }
    })
  )
)

export type LoginAnswer =
  | { readonly status: 'logged_in'; readonly account: string }
  | { readonly status: 'mfa'; readonly id: string; readonly method: string }
  | { readonly status: 'error'; readonly message: string }

const string = (input: unknown, key: string, max = 512) => {
  const value =
    typeof input === 'object' && input !== null ? (input as Record<string, unknown>)[key] : null
  if (typeof value !== 'string' || value.length > max) throw new Error(`${key}: a string`)
  return value
}

export const garminLogin = createServerFn({ method: 'POST' })
  .validator((input: unknown) => ({
    email: string(input, 'email'),
    password: string(input, 'password'),
  }))
  .handler(({ data }) =>
    runtime.runPromise(
      GarminLogin.use((login) => login.start(data)).pipe(
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
  )

export const garminMfa = createServerFn({ method: 'POST' })
  .validator((input: unknown) => ({ id: string(input, 'id', 64), code: string(input, 'code', 16) }))
  .handler(({ data }) =>
    runtime.runPromise(
      GarminLogin.use((login) => login.mfa(data.id, data.code)).pipe(
        Effect.map((account): LoginAnswer => ({
          status: 'logged_in',
          account: account.full_name ?? account.display_name,
        })),
        Effect.catch((error) =>
          Effect.succeed<LoginAnswer>({ status: 'error', message: explain(error) })
        )
      )
    )
  )

export const garminLogout = createServerFn({ method: 'POST' }).handler(() =>
  runtime.runPromise(GarminLogin.use((login) => login.logout).pipe(Effect.orDie))
)

export const garminSyncNow = createServerFn({ method: 'POST' }).handler(() =>
  runtime.runPromise(GarminSync.use((sync) => sync.trigger))
)

// The whole history, from the oldest activity: in the background, resumed until it completes
export const garminBackfill = createServerFn({ method: 'POST' }).handler(() =>
  runtime.runPromise(GarminSync.use((sync) => Effect.orDie(sync.backfill)))
)

export const getRuns = createServerFn({ method: 'GET' }).handler(() =>
  runtime.runPromise(Stats.use((stats) => stats.runs).pipe(Effect.orDie))
)

export const getActivity = createServerFn({ method: 'GET' })
  .validator((input: unknown) => {
    const id =
      typeof input === 'object' && input !== null ? (input as Record<string, unknown>)['id'] : null
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) {
      throw new Error('id: a positive integer')
    }
    return { id }
  })
  .handler(({ data }) =>
    runtime.runPromise(Stats.use((stats) => stats.activity(data.id)).pipe(Effect.orDie))
  )

export const SLEEP_PERIODS = [30, 90, 365] as const

export const getSleep = createServerFn({ method: 'GET' })
  .validator((input: unknown) => {
    const days =
      typeof input === 'object' && input !== null
        ? (input as Record<string, unknown>)['days']
        : null
    return { days: SLEEP_PERIODS.find((period) => period === days) ?? 30 }
  })
  .handler(({ data }) =>
    runtime.runPromise(Stats.use((stats) => stats.sleep(data.days)).pipe(Effect.orDie))
  )
