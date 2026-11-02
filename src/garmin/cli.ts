import process from 'node:process'

import * as NodeRuntime from '@effect/platform-node/NodeRuntime'
import * as NodeServices from '@effect/platform-node/NodeServices'
import { Console, Effect, Layer, Option, Redacted } from 'effect'
import { Command, Flag, Prompt } from 'effect/cli'
import { FetchHttpClient } from 'effect/http'

import { Database } from '../db.ts'
import { Ingest } from '../ingest.ts'

import { GarminApi } from './api.ts'
import { explain, GarminLogin } from './login.ts'
import { GarminSession } from './session.ts'
import { GarminSync } from './sync.ts'

// The Garmin account from a terminal, like the web app's /garmin page:
//   node src/garmin/cli.ts login                    email, password, MFA code; saves the session
//   node src/garmin/cli.ts status                   which account, until when
//   node src/garmin/cli.ts logout                   forgets the session
//   node src/garmin/cli.ts sync [--since YYYY-MM-DD]
// (`pnpm garmin <command>`; in the container: docker exec -it <container> node src/garmin/cli.ts login)

const fail = (message: string) =>
  Effect.gen(function* () {
    yield* Console.error(message)
    process.exitCode = 1
  })

const login = Command.make(
  'login',
  {},
  Effect.fn(function* () {
    const garmin = yield* GarminLogin
    const email = yield* Prompt.run(Prompt.String({ message: 'Garmin email' }))
    const password = yield* Prompt.run(Prompt.Password({ message: 'Garmin password' }))
    const started = yield* garmin
      .start({ email, password: Redacted.value(password) })
      .pipe(Effect.result)
    if (started._tag === 'Failure') return yield* fail(explain(started.failure))
    let account = started.success._tag === 'LoggedIn' ? started.success.account : null
    if (started.success._tag === 'NeedsMfa') {
      const code = yield* Prompt.run(
        Prompt.String({
          message: `MFA code (Garmin's ${started.success.method === 'email' ? 'email' : 'app'})`,
        })
      )
      const verified = yield* garmin.mfa(started.success.id, code).pipe(Effect.result)
      if (verified._tag === 'Failure') {
        return yield* fail(explain(verified.failure))
      }
      account = verified.success
    }
    const session = yield* GarminSession
    yield* Console.log(
      `Logged in as ${account?.full_name ?? account?.display_name ?? '?'}; session saved in ${session.path}.`
    )
    yield* Console.log('The app syncs within a minute (or run `pnpm garmin sync` now).')
  })
).pipe(Command.withDescription('Log the Garmin account in and save its session'))

const status = Command.make(
  'status',
  {},
  Effect.fn(function* () {
    const garmin = yield* GarminLogin
    const current = yield* garmin.status
    if (!current.logged_in) return yield* fail('Not logged in: `pnpm garmin login`.')
    // Asks Garmin, so a revoked session shows
    const account = yield* GarminApi.use((api) => api.profile).pipe(Effect.result)
    if (account._tag === 'Failure')
      return yield* fail(`Session refused: ${account.failure.message}`)
    yield* Console.log(
      `Logged in as ${account.success.full_name ?? account.success.display_name}; token valid until ${current.expires_at ?? '?'} (refreshed before).`
    )
  })
).pipe(Command.withDescription('Which Garmin account is logged in, is its session valid'))

const logout = Command.make(
  'logout',
  {},
  Effect.fn(function* () {
    const session = yield* GarminSession
    yield* session.clear
    yield* Console.log(`Session forgotten (${session.path} removed).`)
  })
).pipe(Command.withDescription('Forget the Garmin session'))

const sync = Command.make(
  'sync',
  {
    since: Flag.String('since').pipe(
      Flag.withDescription('YYYY-MM-DD: fetch again from this day'),
      Flag.optional
    ),
  },
  Effect.fn(function* ({ since }) {
    const outcome = yield* GarminSync.use((service) =>
      service.run(Option.isSome(since) ? { since: since.value } : {})
    )
    for (const warning of outcome.warnings) yield* Console.error(`warning: ${warning}`)
    if (!outcome.ok) return yield* fail(`Sync failed: ${outcome.error ?? ''}`)
    yield* Console.log(
      `Synced ${outcome.account ?? '?'} from ${outcome.since ?? '?'}: ${outcome.files_written} file(s) written.`
    )
  })
).pipe(Command.withDescription('Sync Garmin Connect into DATA_DIR and DATABASE_PATH now'))

const garmin = Command.make('garmin').pipe(
  Command.withDescription('The Garmin account: login, status, logout, sync'),
  Command.withSubcommands([login, status, logout, sync])
)

if (import.meta.main) {
  garmin.pipe(
    Command.run({ version: '1.0.0' }),
    Effect.provide(
      GarminLogin.layer.pipe(
        Layer.provideMerge(GarminSync.layer),
        Layer.provideMerge(GarminApi.layer),
        Layer.provideMerge(GarminSession.layer),
        Layer.provideMerge(Ingest.layer),
        Layer.provideMerge(Database.layer),
        Layer.provideMerge(Layer.merge(NodeServices.layer, FetchHttpClient.layer))
      )
    ),
    NodeRuntime.runMain
  )
}
