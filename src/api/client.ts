import { createORPCClient } from '@orpc/client'
import { RPCLink } from '@orpc/client/fetch'
import { createRouterClient, type RouterClient } from '@orpc/server'
import { createIsomorphicFn } from '@tanstack/react-start'
import { getRequest } from '@tanstack/react-start/server'

import { publicOrigin } from '../auth.ts'

import { type Router, router } from './router.ts'
import { run } from './server.ts'

// The web pages' typed client: during server rendering it calls the procedures in place (the page
// already passed the gate), in the browser it calls /rpc with the session cookie. The server branch
// and its imports never reach the browser's bundle.
const make = createIsomorphicFn()
  .server((): RouterClient<Router> =>
    createRouterClient(router, {
      context: () => ({ run, origin: publicOrigin(getRequest()) }),
    })
  )
  .client((): RouterClient<Router> =>
    createORPCClient(new RPCLink({ origin: window.location.origin, url: '/rpc' }))
  )

export const api = make()
