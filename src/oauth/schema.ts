import { index, sqliteTable, text } from 'drizzle-orm/sqlite-core'

// The OAuth server's state (see oauth.ts), in its own SQLite file beside the password
// (AUTH_DATABASE_PATH): never in the app's database, which the MCP's SQL reads and which is
// rebuilt from data/. `pnpm db:generate:auth <name>` writes its next migration into drizzle-auth/.
// Tokens are kept as their SHA-256 only. Timestamps are ISO 8601 UTC text.

// The applications that registered themselves (RFC 7591): public clients, PKCE, no secret
export const clients = sqliteTable('clients', {
  id: text().primaryKey(),
  name: text().notNull(),
  // Where the authorization may send the code back: exact matches only
  redirect_uris: text({ mode: 'json' }).$type<ReadonlyArray<string>>().notNull(),
  created_at: text().notNull(),
})

// One authorization given on /authorize: its refresh token (rotated at each use: the previous one
// presented again means it leaked, and revokes the grant), until revoked (on /access, or by a new
// password)
export const grants = sqliteTable(
  'grants',
  {
    id: text().primaryKey(),
    client_id: text()
      .notNull()
      .references(() => clients.id, { onDelete: 'cascade' }),
    scope: text().notNull(),
    // The MCP's URL the tokens are for (RFC 8707)
    resource: text().notNull(),
    created_at: text().notNull(),
    used_at: text().notNull(),
    refresh_hash: text().notNull().unique(),
    refresh_expires_at: text().notNull(),
    refreshed_at: text().notNull(),
    previous_refresh_hash: text(),
  },
  (table) => [
    index('grants_client').on(table.client_id),
    index('grants_previous_refresh').on(table.previous_refresh_hash),
  ]
)

// The short-lived bearer tokens of a grant
export const accessTokens = sqliteTable(
  'access_tokens',
  {
    hash: text().primaryKey(),
    grant_id: text()
      .notNull()
      .references(() => grants.id, { onDelete: 'cascade' }),
    expires_at: text().notNull(),
  },
  (table) => [index('access_tokens_grant').on(table.grant_id)]
)
