import { createFileRoute, Link } from '@tanstack/react-router'

import { LineChart, shortDay, StackedColumns } from '#src/components/charts.tsx'
import { dayLabel, fmt, hours, longDay, numericDay, pace, sport } from '#src/components/format.ts'
import { getDashboard } from '#src/server/functions.ts'
import type { Period, Week } from '#src/stats.ts'

// The dashboard: the Garmin connection at a glance, the last 7 days, the last night, 12 weeks of
// training, 28 days of recovery, the latest activities
export const Route = createFileRoute('/')({
  loader: () => getDashboard(),
  head: () => ({ meta: [{ title: 'Garmin · stats' }] }),
  component: Dashboard,
})

const when = (iso: string | null) =>
  iso === null
    ? '–'
    : new Date(iso).toLocaleString('fr-FR', {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'Europe/Paris',
      })

function Delta({ now, before, unit }: { now: number; before: number; unit: string }) {
  const diff = Math.round((now - before) * 10) / 10
  if (diff === 0) return <div className="delta">= les 7 jours d'avant</div>
  return (
    <div className="delta">
      {diff > 0 ? '▲' : '▼'} {fmt(Math.abs(diff), 1)} {unit} vs les 7 jours d'avant
    </div>
  )
}

function Tile({
  label,
  value,
  unit,
  children,
}: {
  label: string
  value: string
  unit?: string
  children?: React.ReactNode
}) {
  return (
    <div className="card tile">
      <div className="label">{label}</div>
      <div className="value">
        {value}
        {unit ? <small>{unit}</small> : null}
      </div>
      {children}
    </div>
  )
}

const WEEK_SERIES = [
  { key: 'run', label: 'Course', color: 'var(--series-1)', value: (w: Week) => w.run_h },
  { key: 'bike', label: 'Vélo', color: 'var(--series-2)', value: (w: Week) => w.bike_h },
  { key: 'other', label: 'Autre', color: 'var(--series-3)', value: (w: Week) => w.other_h },
]

function Dashboard() {
  const { dashboard: d, garmin } = Route.useLoaderData()
  const last = garmin.runs.find((run) => run.finished_at !== null)
  const lastOk = garmin.runs.find((run) => run.ok === true)
  const l7: Period = d.last7
  const p7: Period = d.previous7
  const empty = d.totals.activities === 0 && d.totals.days === 0

  return (
    <main>
      <h1>Stats</h1>
      <p className="sub">
        {fmt(d.totals.activities)} activités et {fmt(d.totals.days)} jours en base
        {d.totals.first_day ? ` depuis le ${numericDay(d.totals.first_day)}` : ''}
        {' · '}
        {fmt(d.totals.distance_km)} km au total
      </p>

      <div className="card row" style={{ justifyContent: 'space-between' }}>
        <div className="row">
          {garmin.session.logged_in ? (
            last?.logged_out ? (
              <span className="status bad">Session Garmin refusée</span>
            ) : last?.ok === false ? (
              <span className="status wait">Dernière synchro en échec</span>
            ) : (
              <span className="status good">
                Garmin connecté
                {garmin.session.account
                  ? ` : ${garmin.session.account.full_name ?? garmin.session.account.display_name}`
                  : ''}
              </span>
            )
          ) : (
            <span className="status bad">Garmin non connecté</span>
          )}
          <span className="note">
            {garmin.syncing
              ? 'Synchro en cours…'
              : `Dernière synchro réussie : ${when(lastOk?.finished_at ?? null)}`}
          </span>
        </div>
        <Link to="/garmin">
          {garmin.session.logged_in ? 'Gérer la connexion' : 'Connecter mon compte →'}
        </Link>
      </div>

      {empty ? (
        <section className="card">
          <h2>Aucune donnée pour l'instant</h2>
          <p className="note">
            Connecte ton compte Garmin sur la page <Link to="/garmin">Connexion Garmin</Link> : la
            première synchro récupère les 14 derniers jours. Pour tout l'historique, importe
            l'export Garmin (« Exporter vos données ») avec <code>pnpm backfill export.zip</code>.
          </p>
        </section>
      ) : null}

      <section>
        <h2>7 derniers jours</h2>
        <p className="sub">
          Du{' '}
          {numericDay(
            new Date(Date.parse(`${d.today}T12:00:00Z`) - 6 * 86_400_000).toISOString().slice(0, 10)
          )}{' '}
          à aujourd'hui
        </p>
        <div className="grid cols-4">
          <Tile label="Activités" value={fmt(l7.activities)}>
            <Delta now={l7.activities} before={p7.activities} unit="" />
          </Tile>
          <Tile label="Distance" value={fmt(l7.distance_km, 1)} unit="km">
            <Delta now={l7.distance_km} before={p7.distance_km} unit="km" />
          </Tile>
          <Tile label="Temps en mouvement" value={fmt(l7.moving_h, 1)} unit="h">
            <Delta now={l7.moving_h} before={p7.moving_h} unit="h" />
          </Tile>
          <Tile label="Charge d'entraînement" value={fmt(l7.training_load)}>
            <Delta now={l7.training_load} before={p7.training_load} unit="" />
          </Tile>
        </div>
      </section>

      <section>
        <h2>Dernière nuit</h2>
        <p className="sub">
          {d.night ? longDay(d.night.day) : 'Pas encore de nuit enregistrée'} ·{' '}
          <Link to="/sleep">tout le sommeil →</Link>
        </p>
        <div className="grid cols-4">
          <Tile label="Sommeil" value={hours(d.night?.sleep_s)}>
            <div className="delta">score {fmt(d.night?.sleep_score)}</div>
          </Tile>
          <Tile label="HRV de la nuit" value={fmt(d.night?.hrv)} unit="ms">
            <div className="delta">{d.night?.hrv_status?.toLowerCase() ?? '–'}</div>
          </Tile>
          <Tile label="FC au repos" value={fmt(d.night?.resting_hr)} unit="bpm">
            <div className="delta">body battery au réveil {fmt(d.night?.body_battery_wake)}</div>
          </Tile>
          <Tile label="Training readiness" value={fmt(d.night?.readiness)} unit="/ 100">
            <div className="delta">VO2max {fmt(d.night?.vo2max)}</div>
          </Tile>
        </div>
      </section>

      <section className="card">
        <h2>Volume par semaine</h2>
        <p className="sub">Heures en mouvement, 12 dernières semaines</p>
        <StackedColumns
          rows={d.weeks}
          series={WEEK_SERIES}
          x={(w) => w.week}
          unit="h"
          title="Heures en mouvement par semaine et par sport"
        />
      </section>

      <section>
        <h2>Récupération, 28 jours</h2>
        <p className="sub">Une mesure par graphique</p>
        <div className="grid cols-3">
          <div className="card">
            <h2>HRV (ms)</h2>
            <LineChart
              points={d.nights.map((n) => ({
                key: n.day,
                label: dayLabel(n.day),
                tick: shortDay(n.day),
                value: n.hrv,
              }))}
              color="var(--series-1)"
              format={(v) => fmt(v)}
              title="HRV"
            />
          </div>
          <div className="card">
            <h2>FC au repos (bpm)</h2>
            <LineChart
              points={d.nights.map((n) => ({
                key: n.day,
                label: dayLabel(n.day),
                tick: shortDay(n.day),
                value: n.resting_hr,
              }))}
              color="var(--series-1)"
              format={(v) => fmt(v)}
              title="FC au repos"
            />
          </div>
          <div className="card">
            <h2>Sommeil (h)</h2>
            <LineChart
              points={d.nights.map((n) => ({
                key: n.day,
                label: dayLabel(n.day),
                tick: shortDay(n.day),
                value: n.sleep_s === null ? null : n.sleep_s / 3600,
              }))}
              color="var(--series-1)"
              format={(v) => fmt(v, 1)}
              title="Sommeil"
            />
          </div>
        </div>
      </section>

      <section className="card">
        <h2>Dernières activités</h2>
        <p className="sub">
          <Link to="/runs">toutes les courses →</Link>
        </p>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Jour</th>
                <th>Sport</th>
                <th>Nom</th>
                <th className="num">km</th>
                <th className="num">Durée</th>
                <th className="num">Allure</th>
                <th className="num">FC moy.</th>
                <th className="num">Charge</th>
              </tr>
            </thead>
            <tbody>
              {d.recent.map((a) => (
                <tr key={a.id}>
                  <td>{dayLabel(a.day)}</td>
                  <td>{sport(a.sport)}</td>
                  <td>
                    <Link to="/activities/$id" params={{ id: String(a.id) }}>
                      {a.name ?? sport(a.sport)}
                    </Link>
                  </td>
                  <td className="num">{fmt(a.distance_km, 1)}</td>
                  <td className="num">{a.moving_min === null ? '–' : hours(a.moving_min * 60)}</td>
                  <td className="num">{pace(a.pace_s)}</td>
                  <td className="num">{fmt(a.avg_hr)}</td>
                  <td className="num">{fmt(a.training_load)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  )
}
