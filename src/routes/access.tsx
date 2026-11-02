import { createFileRoute, useRouter } from '@tanstack/react-router'
import { useState } from 'react'

import { getAccess, revokeAccess } from '#src/server/functions.ts'

// The applications allowed on the MCP (OAuth), each revocable, and how to connect one
export const Route = createFileRoute('/access')({
  loader: () => getAccess(),
  head: () => ({ meta: [{ title: 'Garmin · accès MCP' }] }),
  component: Access,
})

const when = (iso: string) =>
  new Date(iso).toLocaleString('fr-FR', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Europe/Paris',
  })

function Access() {
  const { mcp, grants } = Route.useLoaderData()
  const router = useRouter()
  const [pending, setPending] = useState<string | null>(null)
  const revoke = (id: string) => {
    setPending(id)
    void revokeAccess({ data: { id } })
      .then(() => router.invalidate())
      .finally(() => setPending(null))
  }
  return (
    <main style={{ maxWidth: 640 }}>
      <h1>Accès MCP</h1>
      <p className="sub">
        Les applications autorisées à lire tes données par le MCP. Changer le mot de passe les
        révoque toutes.
      </p>
      <section className="card" style={{ marginTop: 0 }}>
        {grants.length === 0 ? (
          <p className="note">Aucune application autorisée.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Application</th>
                <th>Autorisée le</th>
                <th>Dernier accès</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {grants.map((grant) => (
                <tr key={grant.id}>
                  <td>
                    {grant.client_name}
                    <div className="note">{grant.redirect_host}</div>
                  </td>
                  <td>{when(grant.created_at)}</td>
                  <td>{when(grant.used_at)}</td>
                  <td style={{ textAlign: 'right' }}>
                    <button
                      className="secondary"
                      disabled={pending === grant.id}
                      onClick={() => revoke(grant.id)}
                    >
                      Révoquer
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      <section className="card">
        <h2>Connecter Claude Code</h2>
        <ol className="steps">
          <li>
            <code>claude mcp add --transport http garmin {mcp}</code>
          </li>
          <li>
            Dans Claude Code, <code>/mcp</code>, puis « Authenticate » sur garmin : le navigateur
            s'ouvre ici, tu autorises.
          </li>
        </ol>
      </section>
    </main>
  )
}
