import { createFileRoute, Link } from '@tanstack/react-router'

import { api } from '#src/api/client.ts'
import { dayLabel, duration, fmt, localTime, pace, sport } from '#src/components/format.ts'

// Every activity, any sport, newest first, by year; one sport at a time when asked
export const Route = createFileRoute('/activities/')({
  validateSearch: (search: Record<string, unknown>): { sport?: string } =>
    typeof search['sport'] === 'string' && /^[a-z_]{1,40}$/u.test(search['sport'])
      ? { sport: search['sport'] }
      : {},
  loaderDeps: ({ search }) => ({ sport: search.sport ?? null }),
  loader: ({ deps }) => api.web.activities({ sport: deps.sport }),
  head: () => ({ meta: [{ title: 'Garmin · activités' }] }),
  component: Activities,
})

function Activities() {
  const { activities, sports } = Route.useLoaderData()
  const chosen = Route.useSearch().sport
  const total = sports.reduce((sum, row) => sum + row.count, 0)
  const years = [...new Set(activities.map((activity) => activity.day.slice(0, 4)))]

  return (
    <main>
      <h1>Activités</h1>
      <p className="sub">
        {fmt(activities.length)} {chosen === undefined ? 'activités' : sport(chosen)}
        {activities.length > 0
          ? ` depuis le ${dayLabel(activities.at(-1)?.day ?? '')} ${activities.at(-1)?.day.slice(0, 4) ?? ''}`
          : ''}
      </p>
      <nav className="periods wrap" aria-label="Sport">
        <Link
          to="/activities"
          search={{}}
          className={chosen === undefined ? 'on' : undefined}
          aria-current={chosen === undefined ? 'page' : undefined}
        >
          Tout ({fmt(total)})
        </Link>
        {sports.map((row) => (
          <Link
            key={row.sport}
            to="/activities"
            search={{ sport: row.sport }}
            className={chosen === row.sport ? 'on' : undefined}
            aria-current={chosen === row.sport ? 'page' : undefined}
          >
            {sport(row.sport)} ({fmt(row.count)})
          </Link>
        ))}
      </nav>

      {activities.length === 0 ? (
        <p className="note muted">
          Aucune activité en base : connecte Garmin sur la page{' '}
          <Link to="/garmin">Connexion Garmin</Link>.
        </p>
      ) : null}

      {years.map((year) => {
        const ofYear = activities.filter((activity) => activity.day.startsWith(year))
        const km = ofYear.reduce((sum, activity) => sum + (activity.distance_km ?? 0), 0)
        const seconds = ofYear.reduce((sum, activity) => sum + (activity.moving_s ?? 0), 0)
        return (
          <section className="card" key={year}>
            <h2>{year}</h2>
            <p className="sub">
              {fmt(ofYear.length)} activités · {fmt(km)} km · {fmt(seconds / 3600)} h
            </p>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Jour</th>
                    <th>Nom</th>
                    <th>Sport</th>
                    <th className="num">km</th>
                    <th className="num">Durée</th>
                    <th className="num">Allure / vitesse</th>
                    <th className="num">FC moy.</th>
                    <th className="num">D+</th>
                    <th className="num">Charge</th>
                  </tr>
                </thead>
                <tbody>
                  {ofYear.map((activity) => (
                    <tr key={activity.id}>
                      <td>
                        {dayLabel(activity.day)}{' '}
                        <span className="muted">{localTime(activity.start_local)}</span>
                      </td>
                      <td>
                        <Link to="/activities/$id" params={{ id: String(activity.id) }}>
                          {activity.name ?? sport(activity.sport)}
                        </Link>
                      </td>
                      <td>{sport(activity.sport)}</td>
                      <td className="num">
                        {activity.distance_km !== null && activity.distance_km > 0
                          ? fmt(activity.distance_km, 1)
                          : '–'}
                      </td>
                      <td className="num">{duration(activity.moving_s)}</td>
                      <td className="num">
                        {activity.on_foot
                          ? activity.pace_s === null
                            ? '–'
                            : `${pace(activity.pace_s)} /km`
                          : activity.speed_kmh === null
                            ? '–'
                            : `${fmt(activity.speed_kmh, 1)} km/h`}
                      </td>
                      <td className="num">{fmt(activity.avg_hr)}</td>
                      <td className="num">{fmt(activity.ascent_m)}</td>
                      <td className="num">{fmt(activity.training_load)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )
      })}
    </main>
  )
}
