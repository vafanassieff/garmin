import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import react from '@vitejs/plugin-react'
import { nitro } from 'nitro/vite'
import { defineConfig } from 'vite'

// The app (TanStack Start on Nitro): the Effect HTTP routes under it (see routes/) and the
// background ingest (see server/nitro.ts). Tests use vitest.config.ts.
export default defineConfig({
  plugins: [
    tanstackStart({ router: { generatedRouteTree: './tree.gen.ts', addExtensions: true } }),
    react(),
    nitro({ plugins: ['./src/server/nitro.ts'] }),
  ],
  server: {
    port: 3000,
    // Vite's own list, then the health data and the secrets: `vite dev` serves the project's files
    // before the app's gate
    fs: {
      deny: [
        '.env',
        '.env.*',
        '*.{crt,pem}',
        '**/.git/**',
        '**/data/**',
        '**/.tokens/**',
        '*.db',
        '*.db-*',
        '*.fit',
        '*.zip',
      ],
    },
  },
})
