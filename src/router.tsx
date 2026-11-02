import { createRouter } from '@tanstack/react-router'

import { routeTree } from './tree.gen.ts'

// The pages and the server routes (see routes/)
export function getRouter() {
  return createRouter({ routeTree, scrollRestoration: true })
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>
  }
}
