import { Auth } from '../auth.ts'

import { runtime } from './runtime.ts'

export const hasPassword = () => runtime.runPromise(Auth.use((auth) => auth.hasPassword))

export const verifyBearer = (token: string, client: string) =>
  runtime.runPromise(Auth.use((auth) => auth.verifyBearer(token, client)))

export const verifySession = (value: string) =>
  runtime.runPromise(Auth.use((auth) => auth.verifySession(value)))
