import { defineConfig } from 'drizzle-kit'

// `pnpm db:generate` diffs src/schema.ts against drizzle/ and writes the next migration there; the
// app applies them at startup (see src/db.ts)
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/schema.ts',
  out: './drizzle',
})
