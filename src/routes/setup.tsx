import { createFileRoute } from '@tanstack/react-router'

import { MIN_PASSWORD_LENGTH } from '#src/password-length.ts'

const ERRORS: Record<string, string> = {
  short: `Au moins ${MIN_PASSWORD_LENGTH} caractères.`,
  mismatch: 'Les deux mots de passe diffèrent.',
}

// The first visit: choose the app's password (the MCP's too). Only while there is none (see
// auth.ts's gate); the form posts to /auth/setup.
export const Route = createFileRoute('/setup')({
  validateSearch: (search: Record<string, unknown>): { readonly error?: string } =>
    typeof search['error'] === 'string' ? { error: search['error'] } : {},
  head: () => ({ meta: [{ title: 'Garmin · mot de passe' }] }),
  component: Setup,
})

function Setup() {
  const { error } = Route.useSearch()
  // Own keys only: not `__proto__` and the like
  const message = error !== undefined && Object.hasOwn(ERRORS, error) ? ERRORS[error] : undefined
  return (
    <div className="shell" style={{ maxWidth: 460, paddingTop: '12vh' }}>
      <div className="card">
        <h1>Garmin</h1>
        <p className="sub">
          Choisis le mot de passe de l'app. Il protège tes données, et c'est aussi le jeton du MCP.
          Seul son hash est gardé, sur le serveur.
        </p>
        <form className="stack" method="post" action="/auth/setup">
          <label>
            Mot de passe
            <input
              type="password"
              name="password"
              autoComplete="new-password"
              minLength={MIN_PASSWORD_LENGTH}
              autoFocus
              required
            />
          </label>
          <label>
            Encore
            <input
              type="password"
              name="again"
              autoComplete="new-password"
              minLength={MIN_PASSWORD_LENGTH}
              required
            />
          </label>
          {message === undefined ? null : <div className="error">{message}</div>}
          <button className="primary" type="submit">
            Choisir
          </button>
        </form>
        <p className="note muted">
          Au moins {MIN_PASSWORD_LENGTH} caractères. Ensuite, tu connectes ton compte Garmin.
        </p>
      </div>
    </div>
  )
}
