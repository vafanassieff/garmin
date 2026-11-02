# The app: the web pages, the MCP at /mcp, the Garmin sync into /data and its ingest, plus the CLIs
# (`node src/garmin/cli.ts login`, `node src/ingest.ts`, `node src/export.ts <zip>`) run from source
# with their production dependencies
FROM node:26.13.0-slim AS builder

RUN npm install --global pnpm@12.16.1

WORKDIR /repo

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches ./patches
RUN pnpm install --frozen-lockfile

COPY . .
# Bundled into .output with everything it imports
RUN pnpm build

# The CLIs' and the MCP's read-only query script's dependencies, without the build's
FROM node:26.13.0-slim AS dependencies

RUN npm install --global pnpm@12.16.1

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches ./patches
RUN pnpm install --frozen-lockfile --prod

FROM node:26.13.0-slim

ENV NODE_ENV=production
# SQLite's localtime (bedtimes in daily_readiness): the user's days, in Paris time
ENV TZ=Europe/Paris
ENV HOST=0.0.0.0
ENV PORT=3000
ENV DATA_DIR=/data
ENV DATABASE_PATH=/data/garmin.db
# The Garmin session's tokens: a volume of their own, never under /data
ENV GARMIN_SESSION_PATH=/session/garmin.json
# The app's password's hash, chosen on the first visit (/setup): beside it, never under /data
ENV PASSWORD_PATH=/session/password

# drizzle/, drizzle-auth/ and src/ are resolved from here (see src/db.ts, src/reader.ts)
WORKDIR /app

COPY --from=dependencies --chown=node:node /app /app
COPY --from=builder --chown=node:node /repo/.output /app/.output
COPY --from=builder --chown=node:node /repo/drizzle /app/drizzle
COPY --from=builder --chown=node:node /repo/drizzle-auth /app/drizzle-auth
COPY --from=builder --chown=node:node /repo/src /app/src

# Owned by the app for a fresh volume (a bind mount: chown 1000 it on the host)
RUN mkdir -m 700 /session && chown node:node /session

USER node

CMD ["node", ".output/server/index.mjs"]
