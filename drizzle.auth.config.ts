import { defineConfig } from 'drizzle-kit'

// `pnpm db:generate:auth` diffs src/oauth/schema.ts against drizzle-auth/ and writes the next
// migration there; the app applies them to AUTH_DATABASE_PATH at startup (see src/oauth/oauth.ts)
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/oauth/schema.ts',
  out: './drizzle-auth',
})
