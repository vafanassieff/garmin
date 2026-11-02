import { createFileRoute } from '@tanstack/react-router'

import { MIN_PASSWORD_LENGTH } from '#src/password-length.ts'

const ERRORS: Record<string, string> = {
  short: `Le nouveau mot de passe fait au moins ${MIN_PASSWORD_LENGTH} caractères.`,
  mismatch: 'Les deux nouveaux mots de passe diffèrent.',
  wrong: 'Mot de passe actuel refusé.',
  throttled: "Trop d'essais : réessaie dans une minute.",
}

// A new app password, for the current one: the form posts to /auth/password
export const Route = createFileRoute('/password')({
  validateSearch: (
    search: Record<string, unknown>
  ): { readonly error?: string; readonly changed?: boolean } => ({
    ...(typeof search['error'] === 'string' ? { error: search['error'] } : {}),
    ...(search['changed'] === undefined ? {} : { changed: true }),
  }),
  head: () => ({ meta: [{ title: 'Garmin · mot de passe' }] }),
  component: Password,
})

function Password() {
  const { error, changed } = Route.useSearch()
  // Own keys only: not `__proto__` and the like
  const message = error !== undefined && Object.hasOwn(ERRORS, error) ? ERRORS[error] : undefined
  return (
    <main style={{ maxWidth: 460 }}>
      <h1>Mot de passe de l'app</h1>
      <p className="sub">
        Celui du site et du MCP. Le changer déconnecte tes autres navigateurs, et le MCP devra
        prendre le nouveau.
      </p>
      <section className="card" style={{ marginTop: 0 }}>
        <form className="stack" method="post" action="/auth/password">
          <label>
            Mot de passe actuel
            <input type="password" name="current" autoComplete="current-password" required />
          </label>
          <label>
            Nouveau
            <input
              type="password"
              name="password"
              autoComplete="new-password"
              minLength={MIN_PASSWORD_LENGTH}
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
          {changed === true ? <div className="note">Mot de passe changé.</div> : null}
          <button className="primary" type="submit">
            Changer
          </button>
        </form>
      </section>
    </main>
  )
}
