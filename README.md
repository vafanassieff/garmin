# garmin

All of one's Garmin data in one place, in TypeScript and Effect from end to end (no Python):
the Garmin account's login, the sync of Garmin Connect, SQLite, an MCP for Claude and a small web
app (TanStack Start + React) to connect the account and see the runs, the sleep and a few stats.

## How it works

```
Garmin account ──(garmin/: SSO login + MFA, session tokens, sync every 3 h)──▶ data/ (raw files)
GDPR export zip ──(pnpm backfill)───────────────────────────────────────────▶ data/
data/ ──(ingest, @garmin/fitsdk)──▶ SQLite ──▶ MCP at /mcp, web pages at /
```

- **The app owns the Garmin account** (`src/garmin/`). It logs in like Garmin Connect's mobile
  app: the email and password to Garmin's SSO (`sso.garmin.com/mobile/api/login`, then the
  portal's flow if that one is rate limited), the MFA code Garmin sends, then the service ticket
  traded at `diauth.garmin.com` for an OAuth2 access token (about a day) and its refresh token.
  Only those tokens are kept, in their own file (`GARMIN_SESSION_PATH`, 0600 in a 0700
  directory: never in SQLite, which the MCP's SQL reads, never in `data/`, never logged). The
  password is never stored. The access token is refreshed 15 minutes before it expires, and once
  more on a 401.
- **Log in from the web app** (`/garmin`: email, password, then the MFA code) or from a terminal
  (`pnpm garmin login`). The sync starts right after.
- **The sync** (`garmin/sync.ts`) runs every `SYNC_EVERY_HOURS` (3), or at once after a login
  or "sync now": it writes the raw files into `data/`, ingests them into SQLite, and records the
  run in `sync_runs`. When Garmin refuses the session, the run says `logged_out`, the web app and
  the MCP's `sync_status` say to log in again, and the loop waits for a new session.
- **Raw files are the source of truth**, kept on disk, never in git. The database can always be
  rebuilt from them (`pnpm ingest --rebuild`). FIT files go through Garmin's official FIT SDK
  (`@garmin/fitsdk`); Garmin Connect's JSON gives what FIT files do not hold (names, load, gear,
  sleep, HRV, readiness, weight, the calendar).
- **One password** guards everything: the MCP takes it as a bearer token (or an OAuth token, see
  below), the web app's `/login` sets a signed session cookie (30 days, `Secure` but on localhost). It is chosen in the web app on
  the first visit (`/setup`, at least 12 characters), changed on `/password` (which logs every
  other browser and the MCP out), and only its scrypt hash is kept, in its own file
  (`PASSWORD_PATH`, 0600 in a 0700 directory, beside the Garmin session). Logging out logs every
  browser out (not the MCP), a copied cookie included. Until it is chosen the
  app offers nothing but `/setup`, to whoever opens it first: open it right after deploying.
  Wrong passwords are throttled: 10 a minute per client (the last address of `X-Forwarded-For`,
  set by the reverse proxy), 60 a minute in all, 2 checks at a time; past that the login says to
  wait a minute and the MCP answers 429. A POST from another site is refused (CSRF), and every
  answer carries `frame-ancestors 'none'`, `nosniff`, HSTS and `no-store`.

- **OAuth for the MCP** (`src/oauth/`): MCP clients such as Claude Code find the app's OAuth 2.1
  server from the MCP's 401 (RFC 9728, then RFC 8414), register themselves (RFC 7591, public
  clients), and send the browser to `/authorize`. There, logged in to the web app, the owner
  allows them, and the client trades the code for tokens with PKCE (S256). Access tokens last an
  hour, refresh tokens 30 days, rotated at each use. Clients and grants live in their own SQLite
  file (`AUTH_DATABASE_PATH`, beside the password, never in the database the MCP's SQL reads),
  through drizzle (`drizzle-auth/`), tokens as their SHA-256 only. `/access` lists the allowed
  applications and revokes one; a new password revokes them all.

### `data/` layout

| Path                                       | What                                                                     | From         |
| ------------------------------------------ | ------------------------------------------------------------------------ | ------------ |
| `fit/YYYY/<activityId>.fit`                | the activity's original FIT file                                         | sync, export |
| `fit/unmatched/<file>.fit`                 | export FIT files no Garmin Connect activity matches (kept, not ingested) | export       |
| `connect/activities/YYYY/<id>.json`        | Garmin Connect's activity summary (name, load, training effect, gear)    | sync         |
| `connect/activities/YYYY/<id>.export.json` | the export's summary of the activity, used when the API's is missing     | export       |
| `connect/daily/YYYY/<date>.json`           | one day: stats, sleep, HRV, training readiness, max metrics              | sync         |
| `connect/body/YYYY-MM.json`                | a month of weigh-ins and body composition                                | sync         |
| `connect/calendar/YYYY-MM.json`            | a month of the Garmin calendar (scheduled workouts)                      | sync         |
| `connect/workouts/<workoutId>.json`        | a workout's steps                                                        | sync         |
| `export/<zip>/…`                           | the export's wellness JSON files, as extracted                           | export       |
| `garmin.db`                                | SQLite, rebuilt from the above                                           | ingest       |

## Schema

Timestamps are ISO 8601 UTC text, local times `YYYY-MM-DDTHH:MM:SS` text, days `YYYY-MM-DD` (the
watch's local day). Distances in metres, durations in seconds, speeds in m/s.

- `activities`: one row per activity (Garmin Connect's activity id). sport, sub_sport, name, start
  (UTC and local), day, elapsed / moving duration, distance, ascent / descent, avg / max HR, avg
  speed, cadence, power, calories, training load, aerobic / anaerobic training effect, time in each
  HR zone (with the watch's zone bounds), gear, start point, a simplified polyline for maps.
- `laps`: activity_id, index, start, durations, distance, HR, speed, cadence, power, ascent,
  intensity (active / rest / warmup / cooldown), the workout step it ran.
- `samples`: per second: (activity_id, t) primary key, `WITHOUT ROWID`: lat, lon, alt, hr, speed,
  cadence, power, distance.
- `daily`: one row per day: sleep (times, stages, score), overnight HRV and HRV status, resting HR,
  body battery, steps, stress, intensity minutes, training readiness, VO2max, race predictions.
- `body`: weigh-ins: weight, BMI, body fat, water, muscle and bone mass.
- `planned_workouts`: the Garmin calendar's workouts: day, name, sport, steps.
- `raw_files`: every file of `data/` ingested, with its size, mtime and error, so a sync only
  re-reads what changed.
- `sync_runs`: each sync with Garmin Connect: when, as whom, from which day, files written,
  warnings (calls that failed without stopping it), error, `logged_out`.
- Views for SQL: `activity_summary` (paces, minutes, zones in minutes), `weekly` (per ISO week and
  sport).

## Modules

```
src/
  garmin/
    sso.ts         Garmin's SSO: login (mobile, then portal), MFA, ticket → DI tokens, refresh
    session.ts     the session's tokens in GARMIN_SESSION_PATH (0600), refreshed under a lock
    api.ts         Garmin Connect's API (connectapi.garmin.com) with the bearer, 401 → refresh
    sync.ts        Garmin Connect → data/ → ingest, sync_runs, the 3-hour loop
    login.ts       the login's two steps (MFA kept in memory 10 min) for the web and the CLI
    cli.ts         `pnpm garmin login | status | logout | sync [--since YYYY-MM-DD]`
  schema.ts        drizzle schema (tables + views); `pnpm db:generate <name>` → drizzle/
  db.ts            the SQLite connection, migrated at startup
  fit.ts           FIT file → activity, laps, samples (@garmin/fitsdk)
  polyline.ts      Douglas-Peucker + Google encoded polyline
  connect.ts       Garmin Connect / export JSON → activity summary, daily, body, workouts
  ingest.ts        data/ → SQLite (changed files only); CLI `pnpm ingest [--rebuild]`
  export.ts        GDPR export zip → data/; CLI `pnpm backfill <zip>`
  reader.ts        read-only SQL in a child process (read-only.ts), killed past 30s
  tools.ts         the typed MCP tools' queries
  stats.ts         the web pages' queries (dashboard, runs, one activity, sleep)
  mcp.ts           MCP toolkit at /mcp
  auth.ts          the password: MCP bearer, web session cookie, the gate in front of everything
  oauth/           the MCP's OAuth server: schema (drizzle-auth/), service, consent page, metadata
  password.ts      scrypt hash
  http.ts          /healthz
  app.ts           layers; jobs: the Garmin sync, the ingest every 5 minutes
  routes/          TanStack Start: / (stats), /runs, /activities/$id, /sleep, /garmin (connection),
                   /setup, /login, /password, /access, /auth/*, /authorize, /oauth/*,
                   /.well-known/*, /mcp, /healthz
  components/      the pages' charts (plain SVG, no chart library), formats, segmented bars' parts
  server/          TanStack Start glue (runtime, nitro plugin, server functions)
```

## Web app

- `/setup` (first visit only): choose the app's password. `/login`: enter it. `/password`:
  change it.
- `/` (stats): the Garmin connection at a glance, the last 7 days against the 7 before, the last
  night (sleep, HRV, resting HR, readiness), hours per week by sport over 12 weeks, HRV / resting
  HR / sleep over 28 days, the latest activities.
- `/runs`: the last 4 weeks of running against the 4 before (distance, runs, pace, HR), km per
  week over 26 weeks, each run's pace, the time per HR zone, the longest run, VO2max and Garmin's
  race predictions, every run of the 26 weeks.
- `/activities/$id`: one activity: its numbers, its route (drawn from its polyline, no map tiles),
  its time per HR zone, its pace (or speed), HR and altitude minute by minute on one crosshair,
  its kilometres and laps.
- `/sleep?days=30|90|365`: the last night (duration, score, bedtime and wake time in Paris time,
  HRV against Garmin's baseline, resting HR, breathing, SpO2, body battery, its stages), the
  period's averages against the period before, the stages and the schedule night by night (week
  by week over a year), HRV with its baseline band, sleep score, resting HR, body battery at wake.
- `/access`: the applications allowed on the MCP through OAuth, when they last used it, a button
  to revoke each; how to connect Claude Code.
- `/garmin`: is the account connected, as whom, until when; log in (email, password, MFA code);
  sync now; switch account; log out; the last syncs and their errors; how the login works.

## MCP tools

- `list_activities`, `get_activity` (laps, zones, km splits), `compare_runs`, `daily_readiness`
  (with 28-day baselines), `weekly_load` (acute / chronic load), `planned_workouts`, `sync_status`
  (the Garmin session, the last syncs, how fresh the data is).
- `schema` and `sql`: one read-only SQLite statement (read-only connection, `PRAGMA query_only`,
  an authorizer that only allows reads, its own process killed after 30 s).

## Commands

- `pnpm dev`: the app on :3000 (needs `DATABASE_PATH`, `DATA_DIR`; `GARMIN_SESSION_PATH` and
  `PASSWORD_PATH` default to `.tokens/`, gitignored)
- `pnpm test`, `pnpm check` (format, lint, type-check)
- `pnpm garmin login`: log the Garmin account in from a terminal (email, password, MFA code);
  `pnpm garmin status`, `pnpm garmin logout`, `pnpm garmin sync [--since 2026-01-01]`
- `pnpm db:generate <name>`, `pnpm db:generate:auth <name>`: the next migration of `src/schema.ts`
  (into `drizzle/`), of `src/oauth/schema.ts` (into `drizzle-auth/`)
- `pnpm ingest [--rebuild]`: ingest `data/` now
- `pnpm backfill <export.zip>`: import a Garmin "Export your data" zip

Garmin rate limits logins per address: from a laptop the SSO may answer 429 (or Cloudflare 403)
when the server's address goes through. Log in from the server's web app.

## MCP clients

Streamable HTTP at `/mcp`. Claude Code, with OAuth (nothing to store but its own tokens):

```sh
claude mcp add --transport http garmin https://garmin.example.com/mcp
claude mcp login garmin   # or /mcp in a session: the browser opens /authorize, allow it
```

Or the app's password as bearer token (`--header "Authorization: Bearer <password>"`).

Over plain HTTP, `initialize` first: its `Mcp-Session-Id` response header goes on every next call.

## Deploy

One image, built from the `Dockerfile` (`.github/workflows/images.yml` pushes it to ghcr on every
push to `main`). It runs as uid 1000, listens on :3000, and keeps two volumes: `/data` (raw files,
SQLite) and `/session` (the Garmin session's tokens, the app's password hash and the OAuth
database, 0700). It holds
health data: keep it on a private network (a VPN such as Tailscale), behind a reverse proxy that
terminates TLS.

```yaml
garmin:
  image: ghcr.io/vafanassieff/garmin:latest
  restart: unless-stopped
  volumes:
    - ./garmin/data:/data
    - ./garmin/session:/session
  environment:
    TZ: Europe/Paris
```

1. Create both directories owned by uid 1000, in 0700 (the app creates every file 0600)
2. Start it and open `/setup` at once: choose the app's password
3. On `/garmin`, log the Garmin account in (email, password, the MFA code Garmin sends). The
   first sync (last 14 days) starts at once. From a terminal instead:
   `docker exec -it <container> node src/garmin/cli.ts login`
4. History: Garmin's export zip into `data/import/`, then
   `docker exec <container> node src/export.ts /data/import/<export>.zip`; or from the API alone,
   slower: `docker exec <container> node src/garmin/cli.ts sync --since 2024-01-01`

Logged out later (Garmin revoked the session, password changed): `/garmin`, `sync_status` and
the logs say so; log in again on `/garmin`.
