import {
  createRootRoute,
  HeadContent,
  Link,
  Outlet,
  Scripts,
  useRouterState,
} from '@tanstack/react-router'

import css from '../styles.css?url'

// The document shell: the nav (but on the login and first-password pages) and the pages
export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { name: 'robots', content: 'noindex' },
      { title: 'Garmin' },
    ],
    links: [{ rel: 'stylesheet', href: css }],
  }),
  shellComponent: ({ children }) => (
    <html lang="fr">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  ),
  component: Layout,
})

function Layout() {
  const path = useRouterState({ select: (state) => state.location.pathname })
  if (path === '/login' || path === '/setup') return <Outlet />
  return (
    <div className="shell">
      <header className="top">
        <Link to="/" className="brand">
          Garmin
        </Link>
        <nav>
          <Link to="/" activeOptions={{ exact: true }}>
            Stats
          </Link>
          <Link to="/activities" activeOptions={{ exact: true }}>
            Activités
          </Link>
          <Link to="/runs">Courses</Link>
          <Link to="/sleep">Sommeil</Link>
          <Link to="/garmin">Connexion Garmin</Link>
          <Link to="/password">Mot de passe</Link>
        </nav>
        <form method="post" action="/auth/logout">
          <button type="submit">Déconnexion</button>
        </form>
      </header>
      <Outlet />
    </div>
  )
}
