import { createFileRoute } from '@tanstack/react-router'

// The app's password (the MCP's too): the form posts to /auth/login, which sets the session
export const Route = createFileRoute('/login')({
  validateSearch: (search: Record<string, unknown>) => ({
    next: typeof search['next'] === 'string' ? search['next'] : undefined,
    // A wrong password, or too many of them (see auth.ts)
    error:
      search['error'] === 'busy'
        ? ('busy' as const)
        : search['error'] === undefined
          ? undefined
          : ('wrong' as const),
  }),
  head: () => ({ meta: [{ title: 'Garmin · connexion' }] }),
  component: Login,
})

function Login() {
  const { next, error } = Route.useSearch()
  return (
    <div className="shell" style={{ maxWidth: 420, paddingTop: '12vh' }}>
      <div className="card">
        <h1>Garmin</h1>
        <p className="sub">Le mot de passe de l'app (le même que le jeton du MCP).</p>
        <form className="stack" method="post" action="/auth/login">
          <input type="hidden" name="next" value={next ?? '/'} />
          <label>
            Mot de passe
            <input
              type="password"
              name="password"
              autoComplete="current-password"
              autoFocus
              required
            />
          </label>
          {error === 'busy' ? (
            <div className="error">Trop d'essais : réessaie dans une minute.</div>
          ) : error === 'wrong' ? (
            <div className="error">Mot de passe refusé.</div>
          ) : null}
          <button className="primary" type="submit">
            Entrer
          </button>
        </form>
      </div>
    </div>
  )
}
