import { createFileRoute, useRouter } from '@tanstack/react-router'
import { useEffect, useState } from 'react'

import { api } from '#src/api/client.ts'
import type { LoginAnswer } from '#src/api/web.ts'

// The Garmin account: is it connected, log it in (email, password, then the MFA code), sync now,
// the last syncs, and how it works
export const Route = createFileRoute('/garmin')({
  loader: () => api.web.garmin(),
  head: () => ({ meta: [{ title: 'Garmin · connexion' }] }),
  component: GarminPage,
})

const when = (iso: string | null) =>
  iso === null
    ? '–'
    : new Date(iso).toLocaleString('fr-FR', {
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'Europe/Paris',
      })

const field = (form: FormData, name: string) => {
  const value = form.get(name)
  return typeof value === 'string' ? value : ''
}

type Step =
  | { readonly kind: 'credentials' }
  | { readonly kind: 'mfa'; readonly id: string; readonly method: string }
  | { readonly kind: 'done'; readonly account: string }

function LoginForm({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState<Step>({ kind: 'credentials' })
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  const answer = (result: LoginAnswer) => {
    if (result.status === 'error') setError(result.message)
    else if (result.status === 'mfa') {
      setError(null)
      setStep({ kind: 'mfa', id: result.id, method: result.method })
    } else {
      setError(null)
      setStep({ kind: 'done', account: result.account })
      onDone()
    }
  }

  const submit = (
    event: React.SubmitEvent<HTMLFormElement>,
    send: (form: FormData) => Promise<LoginAnswer>
  ) => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    setPending(true)
    send(form)
      .then(answer)
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setPending(false))
  }

  if (step.kind === 'done') {
    return (
      <p className="note">
        <span className="status good">Connecté : {step.account}</span> La première synchro démarre.
      </p>
    )
  }

  if (step.kind === 'mfa') {
    return (
      <form
        className="stack"
        onSubmit={(event) =>
          submit(event, (form) => api.web.garminMfa({ id: step.id, code: field(form, 'code') }))
        }
      >
        <p className="note">
          Garmin vient d'envoyer un code à 6 chiffres{' '}
          {step.method === 'email' ? 'par email' : `(${step.method})`}. Il reste valable quelques
          minutes.
        </p>
        <label>
          Code MFA
          <input
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]{4,8}"
            maxLength={8}
            autoFocus
            required
          />
        </label>
        {error ? <div className="error">{error}</div> : null}
        <div className="row">
          <button className="primary" type="submit" disabled={pending}>
            {pending ? 'Vérification…' : 'Valider'}
          </button>
          <button
            className="secondary"
            type="button"
            onClick={() => setStep({ kind: 'credentials' })}
          >
            Recommencer
          </button>
        </div>
      </form>
    )
  }

  return (
    <form
      className="stack"
      onSubmit={(event) =>
        submit(event, (form) =>
          api.web.garminLogin({
            email: field(form, 'email'),
            password: field(form, 'password'),
          })
        )
      }
    >
      <label>
        Email Garmin
        <input name="email" type="email" autoComplete="username" required />
      </label>
      <label>
        Mot de passe Garmin
        <input name="password" type="password" autoComplete="current-password" required />
      </label>
      {error ? <div className="error">{error}</div> : null}
      <button className="primary" type="submit" disabled={pending}>
        {pending ? 'Connexion à Garmin… (jusqu’à 30 s)' : 'Se connecter à Garmin'}
      </button>
      <p className="note muted">
        Le mot de passe part directement à Garmin et n'est jamais enregistré.
      </p>
    </form>
  )
}

function GarminPage() {
  const view = Route.useLoaderData()
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const refresh = () => router.invalidate()
  const { session, runs, syncing, backfilling } = view
  const last = runs.find((run) => run.finished_at !== null)
  const refused = session.logged_in && last?.logged_out === true
  const [relogin, setRelogin] = useState(false)

  // While a sync runs, the page follows it
  useEffect(() => {
    if (!syncing) return
    const timer = setInterval(() => void router.invalidate(), 3000)
    return () => clearInterval(timer)
  }, [syncing, router])

  return (
    <main>
      <h1>Connexion Garmin</h1>
      <p className="sub">
        Le compte Garmin Connect dont l'app récupère les données toutes les 3 heures.
      </p>

      <div className="grid cols-2">
        <div className="card">
          <h2>État</h2>
          {session.logged_in ? (
            refused ? (
              <p>
                <span className="status bad">Garmin a refusé la session</span>
                <br />
                <span className="note">
                  Reconnecte-toi ci-dessous (mot de passe changé, session révoquée…).
                </span>
              </p>
            ) : (
              <p>
                <span className="status good">
                  Connecté :{' '}
                  {session.account?.full_name ?? session.account?.display_name ?? 'compte Garmin'}
                </span>
              </p>
            )
          ) : (
            <p>
              <span className="status bad">Non connecté</span>
            </p>
          )}
          {session.logged_in ? (
            <>
              <table>
                <tbody>
                  <tr>
                    <td className="muted">Session enregistrée</td>
                    <td>{when(session.saved_at)}</td>
                  </tr>
                  <tr>
                    <td className="muted">Jeton d'accès valable jusqu'au</td>
                    <td>
                      {when(session.expires_at)}
                      <span className="muted">
                        {' '}
                        {session.refreshable ? '(renouvelé automatiquement)' : '(non renouvelable)'}
                      </span>
                    </td>
                  </tr>
                  <tr>
                    <td className="muted">Synchro</td>
                    <td>
                      {syncing ? 'en cours…' : `dernière le ${when(last?.finished_at ?? null)}`}
                    </td>
                  </tr>
                  {backfilling ? (
                    <tr>
                      <td className="muted">Historique complet</td>
                      <td>
                        en cours, depuis la plus ancienne activité, une requête par seconde ; si
                        Garmin limite, il reprend tout seul une demi-heure plus tard
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
              <div className="row" style={{ marginTop: 12 }}>
                <button
                  className="primary"
                  disabled={busy || syncing}
                  onClick={() => {
                    setBusy(true)
                    void api.web
                      .syncNow()
                      .then(() => new Promise((resolve) => setTimeout(resolve, 800)))
                      .then(refresh)
                      .finally(() => setBusy(false))
                  }}
                >
                  {syncing ? 'Synchro en cours…' : 'Synchroniser maintenant'}
                </button>
                <button
                  className="secondary"
                  disabled={busy || backfilling}
                  onClick={() => {
                    setBusy(true)
                    void api.web
                      .backfill()
                      .then(() => new Promise((resolve) => setTimeout(resolve, 800)))
                      .then(refresh)
                      .finally(() => setBusy(false))
                  }}
                >
                  {backfilling ? 'Historique en cours…' : "Récupérer tout l'historique"}
                </button>
                <button className="secondary" onClick={() => setRelogin((v) => !v)}>
                  Changer de compte
                </button>
                <button
                  className="secondary"
                  onClick={() => {
                    if (
                      window.confirm(
                        'Oublier la session Garmin ? Il faudra se reconnecter (avec le code MFA).'
                      )
                    ) {
                      void api.web.garminLogout().then(refresh)
                    }
                  }}
                >
                  Déconnecter
                </button>
              </div>
            </>
          ) : null}
          {!session.logged_in || refused || relogin ? (
            <div style={{ marginTop: 14 }}>
              <LoginForm onDone={() => void refresh()} />
            </div>
          ) : null}
        </div>

        <div className="card">
          <h2>Comment ça marche</h2>
          <ol className="steps">
            <li>
              Tu entres ton email et ton mot de passe Garmin. L'app les envoie au SSO de Garmin (
              <code>sso.garmin.com</code>), comme le fait l'app mobile Garmin Connect.
            </li>
            <li>
              Si ton compte a la double authentification, Garmin t'envoie un code (email ou app) :
              tu le saisis ici. L'étape attend 10 minutes au plus.
            </li>
            <li>
              Garmin renvoie un ticket, échangé contre un jeton d'accès (valable environ un jour) et
              un jeton de renouvellement. Seuls ces jetons sont gardés, dans un fichier à part (
              <code>GARMIN_SESSION_PATH</code>, permissions 0600), jamais dans la base ni dans les
              logs. Le mot de passe n'est jamais stocké.
            </li>
            <li>
              Toutes les 3 heures, l'app renouvelle le jeton si besoin, télécharge les nouvelles
              activités (fichiers FIT), le sommeil, la HRV, la readiness, les pesées et le
              calendrier, puis les range en base. Le MCP lit cette base.
            </li>
            <li>
              Si Garmin coupe la session, cette page et l'outil MCP <code>sync_status</code>{' '}
              l'indiquent : il suffit de se reconnecter ici. En terminal :{' '}
              <code>pnpm garmin login</code>.
            </li>
          </ol>
        </div>
      </div>

      <section className="card">
        <h2>Dernières synchros</h2>
        {runs.length === 0 ? (
          <p className="note muted">Aucune pour l'instant.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Début</th>
                <th>Compte</th>
                <th>Résultat</th>
                <th className="num">Fichiers</th>
                <th>Détail</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr key={run.started_at}>
                  <td>{when(run.started_at)}</td>
                  <td>{run.account ?? '–'}</td>
                  <td>
                    {run.ok === null ? (
                      <span className="status wait">en cours</span>
                    ) : run.ok ? (
                      <span className="status good">ok</span>
                    ) : run.logged_out ? (
                      <span className="status bad">session refusée</span>
                    ) : (
                      <span className="status bad">échec</span>
                    )}
                  </td>
                  <td className="num">{run.files_written ?? '–'}</td>
                  <td className="note">
                    {run.error ??
                      (run.warnings.length > 0
                        ? `${run.warnings.length} appel(s) en échec : ${run.warnings[0]}`
                        : '')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </main>
  )
}
