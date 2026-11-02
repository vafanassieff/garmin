import { createFileRoute, Link, notFound } from '@tanstack/react-router'
import { useState } from 'react'

import { api } from '#src/api/client.ts'
import { LineChart, RouteMap, SegmentedBar } from '#src/components/charts.tsx'
import { duration, fmt, hours, localTime, longDay, pace, sport } from '#src/components/format.ts'
import { zoneParts } from '#src/components/parts.ts'

// One activity: its numbers, its route, its time per HR zone, its pace, HR and altitude minute by
// minute (one crosshair for the three), its kilometres and laps
export const Route = createFileRoute('/activities/$id')({
  loader: async ({ params }) => {
    const id = Number(params.id)
    if (!Number.isSafeInteger(id) || id <= 0) throw notFound()
    const activity = await api.web.activity({ id })
    if (activity === null) throw notFound()
    return activity
  },
  head: ({ loaderData }) => ({
    meta: [{ title: `Garmin · ${loaderData?.name ?? 'activité'}` }],
  }),
  // Keyed by the activity: another one starts with its own state (no crosshair carried over)
  component: () => {
    const activity = Route.useLoaderData()
    return <Activity key={activity.id} />
  },
  notFoundComponent: () => (
    <main>
      <h1>Activité introuvable</h1>
      <p className="note">
        Elle n'est pas (encore) en base. <Link to="/runs">Retour aux courses</Link>
      </p>
    </main>
  ),
})

function Fact({
  label,
  value,
  unit,
}: {
  readonly label: string
  readonly value: string
  readonly unit?: string
}) {
  return (
    <div>
      <div className="label">{label}</div>
      <div className="value">
        {value}
        {unit !== undefined && value !== '–' ? <small>{unit}</small> : null}
      </div>
    </div>
  )
}

const INTENSITY: Record<string, string> = {
  active: 'effort',
  rest: 'repos',
  warmup: 'échauffement',
  cooldown: 'retour au calme',
  recovery: 'récup',
  interval: 'fractionné',
}

function Activity() {
  const a = Route.useLoaderData()
  const [hover, setHover] = useState<number | null>(null)
  const label = (minute: number) => `${minute} min`
  const series = (value: (m: (typeof a.minutes)[number]) => number | null) =>
    a.minutes.map((m) => ({ key: String(m.minute), label: label(m.minute), value: value(m) }))
  const hasAlt = a.minutes.some((m) => m.alt !== null)
  // Slower than this, a stop rather than a pace: 15 min/km running, 30 walking or hiking
  const slowest = a.sport.includes('running') ? 900 : 1800
  const hasHr = a.minutes.some((m) => m.hr !== null)

  return (
    <main>
      <p className="note">
        <Link to={a.on_foot ? '/runs' : '/'}>← {a.on_foot ? 'Courses' : 'Stats'}</Link>
      </p>
      <h1>{a.name ?? sport(a.sport)}</h1>
      <p className="sub">
        {sport(a.sport)} · {longDay(a.day)} à {localTime(a.start_local)}
        {a.workout_name !== null && !(a.name ?? '').includes(a.workout_name)
          ? ` · séance « ${a.workout_name} »`
          : ''}
        {a.gear ? ` · ${a.gear}` : ''}
      </p>

      <section className="card" style={{ marginTop: 0 }}>
        <div className="hero">
          {a.distance_km !== null && a.distance_km > 0 ? (
            <>
              {fmt(a.distance_km, 2)}
              <small>km</small>
            </>
          ) : (
            hours(a.moving_s)
          )}
        </div>
        <div className="facts">
          <Fact label="Durée" value={duration(a.moving_s)} />
          {a.elapsed_s !== null && a.moving_s !== null && a.elapsed_s - a.moving_s > 60 ? (
            <Fact label="Pauses comprises" value={duration(a.elapsed_s)} />
          ) : null}
          {a.on_foot ? (
            <Fact label="Allure" value={pace(a.pace_s)} unit="/km" />
          ) : (
            <Fact label="Vitesse" value={fmt(a.speed_kmh, 1)} unit="km/h" />
          )}
          <Fact label="FC moyenne" value={fmt(a.avg_hr)} unit="bpm" />
          <Fact label="FC max" value={fmt(a.max_hr)} unit="bpm" />
          <Fact label="D+" value={fmt(a.ascent_m)} unit="m" />
          {a.cadence === null ? null : (
            <Fact label="Cadence" value={fmt(a.cadence)} unit={a.on_foot ? 'pas/min' : 'tr/min'} />
          )}
          {a.avg_power === null ? null : (
            <Fact label="Puissance" value={fmt(a.avg_power)} unit="W" />
          )}
          <Fact label="Charge" value={fmt(a.training_load)} />
          <Fact
            label="Effet aérobie / anaérobie"
            value={`${fmt(a.aerobic_te, 1)} / ${fmt(a.anaerobic_te, 1)}`}
          />
          {a.decoupling_pct === null ? null : (
            <Fact
              label={a.on_foot ? 'Découplage allure/FC' : 'Découplage vitesse/FC'}
              value={fmt(a.decoupling_pct, 1)}
              unit="%"
            />
          )}
          {a.rpe === null ? null : <Fact label="Effort ressenti" value={fmt(a.rpe)} unit="/ 10" />}
          <Fact label="Calories" value={fmt(a.calories)} unit="kcal" />
        </div>
        {a.decoupling_pct === null ? null : (
          <p className="note muted" style={{ marginBottom: 0 }}>
            Découplage : de combien la vitesse par battement baisse de la 1re à la 2e moitié. Sous 5
            %, l'effort est resté aérobie.
          </p>
        )}
      </section>

      <div className="grid cols-2" style={{ marginTop: 14 }}>
        <section className="card" style={{ marginTop: 0 }}>
          <h2>Tracé</h2>
          <RouteMap points={a.route} title={`Tracé de ${a.name ?? 'l’activité'}`} />
        </section>
        <section className="card" style={{ marginTop: 0 }}>
          <h2>Temps par zone de FC</h2>
          {a.zones === null ? (
            <p className="note muted">Pas de zones pour cette activité.</p>
          ) : (
            <SegmentedBar parts={zoneParts(a.zones)} format={hours} title="Temps par zone de FC" />
          )}
        </section>
      </div>

      {a.minutes.length > 1 ? (
        <section className="card">
          <h2>Minute par minute</h2>
          <p className="sub">Moyenne de chaque minute · un seul curseur pour les trois</p>
          <div className="stack-charts">
            {a.on_foot ? (
              <>
                <h3>Allure (min/km, plus haut = plus rapide)</h3>
                <LineChart
                  points={series((m) =>
                    m.pace_s !== null && m.pace_s < slowest ? m.pace_s : null
                  )}
                  color="var(--series-1)"
                  format={pace}
                  title="Allure"
                  invert
                  height={130}
                  hover={hover}
                  onHover={setHover}
                />
              </>
            ) : (
              <>
                <h3>Vitesse (km/h)</h3>
                <LineChart
                  points={series((m) => m.speed_kmh)}
                  color="var(--series-1)"
                  format={(v) => fmt(v, 1)}
                  title="Vitesse"
                  height={130}
                  hover={hover}
                  onHover={setHover}
                />
              </>
            )}
            {hasHr ? (
              <>
                <h3>Fréquence cardiaque (bpm)</h3>
                <LineChart
                  points={series((m) => m.hr)}
                  color="var(--series-1)"
                  format={(v) => fmt(v)}
                  title="FC"
                  height={130}
                  hover={hover}
                  onHover={setHover}
                />
              </>
            ) : null}
            {hasAlt ? (
              <>
                <h3>Altitude (m)</h3>
                <LineChart
                  points={series((m) => m.alt)}
                  color="var(--series-1)"
                  format={(v) => fmt(v)}
                  title="Altitude"
                  height={110}
                  hover={hover}
                  onHover={setHover}
                />
              </>
            ) : null}
          </div>
        </section>
      ) : null}

      {a.on_foot && a.splits.length > 0 ? (
        <section className="card">
          <h2>Kilomètre par kilomètre</h2>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>km</th>
                  <th className="num">Temps</th>
                  <th className="num">Allure</th>
                  <th className="num">FC moy.</th>
                  <th className="num">FC max</th>
                  <th className="num">Cadence</th>
                  <th className="num">D+ / D−</th>
                </tr>
              </thead>
              <tbody>
                {a.splits.map((split) => (
                  <tr key={split.km}>
                    <td>
                      {split.km}
                      {split.distance_km < 0.99 ? (
                        <span className="muted"> ({fmt(split.distance_km, 2)} km)</span>
                      ) : null}
                    </td>
                    <td className="num">{split.time}</td>
                    <td className="num">{split.pace}</td>
                    <td className="num">{fmt(split.avg_hr)}</td>
                    <td className="num">{fmt(split.max_hr)}</td>
                    <td className="num">{fmt(split.cadence)}</td>
                    <td className="num">
                      {fmt(split.ascent_m)} / {fmt(split.descent_m)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {a.laps.length > 1 ? (
        <section className="card">
          <h2>Tours</h2>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Tour</th>
                  <th>Type</th>
                  <th className="num">Distance</th>
                  <th className="num">Temps</th>
                  <th className="num">{a.on_foot ? 'Allure' : 'Vitesse'}</th>
                  <th className="num">FC moy.</th>
                  <th className="num">FC max</th>
                  <th className="num">D+</th>
                </tr>
              </thead>
              <tbody>
                {a.laps.map((lap) => (
                  <tr key={lap.lap}>
                    <td>{lap.lap}</td>
                    <td>{lap.intensity ? (INTENSITY[lap.intensity] ?? lap.intensity) : ''}</td>
                    <td className="num">
                      {lap.distance_m === null ? '–' : `${fmt(lap.distance_m / 1000, 2)} km`}
                    </td>
                    <td className="num">{duration(lap.moving_s)}</td>
                    <td className="num">
                      {a.on_foot
                        ? pace(lap.pace_s)
                        : lap.speed_kmh === null
                          ? '–'
                          : `${fmt(lap.speed_kmh, 1)} km/h`}
                    </td>
                    <td className="num">{fmt(lap.avg_hr)}</td>
                    <td className="num">{fmt(lap.max_hr)}</td>
                    <td className="num">{fmt(lap.ascent_m)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
    </main>
  )
}
