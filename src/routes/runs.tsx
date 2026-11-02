import { createFileRoute, Link } from '@tanstack/react-router'

import { LineChart, SegmentedBar, shortDay, StackedColumns } from '#src/components/charts.tsx'
import { dayLabel, duration, fmt, hours, localTime, pace, sport } from '#src/components/format.ts'
import { zoneParts } from '#src/components/parts.ts'
import { getRuns, RUNS_SPANS } from '#src/server/functions.ts'
import type { RunsSpan, RunWeek } from '#src/stats.ts'

// Running: the last 4 weeks against the 4 before, 26 weeks of distance, each run's pace, the time
// per HR zone, the records and Garmin's race predictions, every run of the period
export const Route = createFileRoute('/runs')({
  // ?span= is optional: 26 weeks by default
  validateSearch: (search: Record<string, unknown>): { span?: RunsSpan } => {
    const asked = search['span']
    const span = RUNS_SPANS.find(
      (option) => option === asked || (typeof option === 'number' && option === Number(asked))
    )
    return span === undefined || span === 26 ? {} : { span }
  },
  loaderDeps: ({ search }) => ({ span: search.span ?? 26 }),
  loader: ({ deps }) => getRuns({ data: { span: deps.span } }),
  head: () => ({ meta: [{ title: 'Garmin · courses' }] }),
  component: Runs,
})

// The change against the 4 weeks before, worded for its direction
function Change({
  now,
  before,
  format,
  lowerIsBetter = false,
}: {
  readonly now: number | null
  readonly before: number | null
  readonly format: (value: number) => string
  readonly lowerIsBetter?: boolean
}) {
  if (now === null || before === null) return <div className="delta">–</div>
  const diff = now - before
  if (Math.abs(diff) < 0.05) return <div className="delta">= les 4 semaines d'avant</div>
  const word = lowerIsBetter ? (diff < 0 ? 'plus rapide' : 'plus lent') : ''
  return (
    <div className="delta">
      {diff > 0 ? '▲' : '▼'} {format(Math.abs(diff))} {word} vs les 4 semaines d'avant
    </div>
  )
}

const SPAN_LABEL: Record<RunsSpan, string> = { 26: '26 semaines', 52: '1 an', all: 'Tout' }
const SPAN_TEXT: Record<RunsSpan, string> = {
  26: '26 dernières semaines',
  52: '52 dernières semaines',
  all: 'depuis la première course',
}

const DISTANCE = [
  {
    key: 'km',
    label: 'Distance',
    color: 'var(--series-1)',
    value: (week: RunWeek) => week.distance_km,
  },
]

function Runs() {
  const view = Route.useLoaderData()
  const span = Route.useSearch().span ?? 26
  const { year, last28: now, previous28: before } = view
  const oldestFirst = view.runs.toReversed()
  const p = view.predictions

  return (
    <main>
      <div className="heading">
        <div>
          <h1>Courses</h1>
          <p className="sub">
            {fmt(year.runs)} sorties depuis le 1er janvier · {fmt(year.distance_km)} km ·{' '}
            {fmt(year.moving_h)} h · {fmt(year.ascent_m)} m de D+
          </p>
        </div>
        <nav className="periods" aria-label="Période">
          {RUNS_SPANS.map((option) => (
            <Link
              key={option}
              to="/runs"
              search={option === 26 ? {} : { span: option }}
              className={option === span ? 'on' : undefined}
              activeOptions={{ exact: true, includeSearch: true }}
              aria-current={option === span ? 'page' : undefined}
            >
              {SPAN_LABEL[option]}
            </Link>
          ))}
        </nav>
      </div>

      <section>
        <h2>4 dernières semaines</h2>
        <p className="sub">Comparées aux 4 semaines d'avant</p>
        <div className="grid cols-4">
          <div className="card tile">
            <div className="label">Distance</div>
            <div className="value">
              {fmt(now.distance_km, 1)}
              <small>km</small>
            </div>
            <Change
              now={now.distance_km}
              before={before.distance_km}
              format={(v) => `${fmt(v, 1)} km`}
            />
          </div>
          <div className="card tile">
            <div className="label">Sorties</div>
            <div className="value">{fmt(now.runs)}</div>
            <Change now={now.runs} before={before.runs} format={(v) => fmt(v)} />
          </div>
          <div className="card tile">
            <div className="label">Allure moyenne</div>
            <div className="value">
              {pace(now.pace_s)}
              <small>/km</small>
            </div>
            <Change
              now={now.pace_s}
              before={before.pace_s}
              format={(v) => `${duration(v)} /km`}
              lowerIsBetter
            />
          </div>
          <div className="card tile">
            <div className="label">FC moyenne</div>
            <div className="value">
              {fmt(now.avg_hr)}
              <small>bpm</small>
            </div>
            <Change now={now.avg_hr} before={before.avg_hr} format={(v) => `${fmt(v)} bpm`} />
          </div>
        </div>
      </section>

      <section className="card">
        <h2>Distance par semaine (km)</h2>
        <p className="sub">{SPAN_TEXT[span]}</p>
        <StackedColumns
          rows={view.weeks}
          series={DISTANCE}
          x={(week) => week.week}
          unit="km"
          title="Kilomètres courus par semaine"
        />
      </section>

      <div className="grid cols-2" style={{ marginTop: 14 }}>
        <section className="card" style={{ marginTop: 0 }}>
          <h2>Allure de chaque sortie (min/km)</h2>
          <p className="sub">Plus haut, plus rapide · {SPAN_TEXT[span]}</p>
          <LineChart
            points={oldestFirst.map((run) => ({
              key: String(run.id),
              label: `${dayLabel(run.day)} · ${run.name ?? sport(run.sport)}`,
              tick: shortDay(run.day),
              // Over 15 min/km is a walk or a watch left running: it would flatten the others
              value: run.pace_s !== null && run.pace_s < 900 ? run.pace_s : null,
            }))}
            color="var(--series-1)"
            format={pace}
            title="Allure"
            invert
            dots
            height={160}
          />
        </section>
        <section className="card" style={{ marginTop: 0 }}>
          <h2>Temps par zone de FC</h2>
          <p className="sub">Toutes les courses des 28 derniers jours</p>
          <SegmentedBar parts={zoneParts(view.zones)} format={hours} title="Temps par zone de FC" />
        </section>
      </div>

      <section className="card">
        <h2>Records et prédictions</h2>
        <div className="facts">
          <div>
            <div className="label">Plus longue sortie</div>
            <div className="value">
              {view.longest ? (
                <Link to="/activities/$id" params={{ id: String(view.longest.id) }}>
                  {fmt(view.longest.distance_km, 1)} km
                </Link>
              ) : (
                '–'
              )}
            </div>
            <div className="note muted">{view.longest ? dayLabel(view.longest.day) : ''}</div>
          </div>
          <div>
            <div className="label">VO2max</div>
            <div className="value">{fmt(view.vo2max?.value, 1)}</div>
            <div className="note muted">{view.vo2max ? dayLabel(view.vo2max.day) : ''}</div>
          </div>
          <div>
            <div className="label">5 km prédit</div>
            <div className="value">{duration(p?.race_5k_s)}</div>
          </div>
          <div>
            <div className="label">10 km prédit</div>
            <div className="value">{duration(p?.race_10k_s)}</div>
          </div>
          <div>
            <div className="label">Semi prédit</div>
            <div className="value">{duration(p?.race_half_s)}</div>
          </div>
          <div>
            <div className="label">Marathon prédit</div>
            <div className="value">{duration(p?.race_marathon_s)}</div>
          </div>
        </div>
        {p ? <p className="note muted">Prédictions Garmin du {dayLabel(p.day)}</p> : null}
      </section>

      <section className="card">
        <h2>Toutes les sorties</h2>
        <p className="sub">
          {fmt(view.runs.length)} · {SPAN_TEXT[span]}
        </p>
        {view.runs.length === 0 ? (
          <p className="note muted">Aucune course sur la période.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Jour</th>
                  <th>Nom</th>
                  <th className="num">km</th>
                  <th className="num">Durée</th>
                  <th className="num">Allure</th>
                  <th className="num">FC moy.</th>
                  <th className="num">D+</th>
                  <th className="num">Charge</th>
                </tr>
              </thead>
              <tbody>
                {view.runs.map((run) => (
                  <tr key={run.id}>
                    <td>
                      {dayLabel(run.day)}{' '}
                      <span className="muted">{localTime(run.start_local)}</span>
                    </td>
                    <td>
                      <Link to="/activities/$id" params={{ id: String(run.id) }}>
                        {run.name ?? sport(run.sport)}
                      </Link>
                    </td>
                    <td className="num">{fmt(run.distance_km, 1)}</td>
                    <td className="num">{duration(run.moving_s)}</td>
                    <td className="num">{pace(run.pace_s)}</td>
                    <td className="num">{fmt(run.avg_hr)}</td>
                    <td className="num">{fmt(run.ascent_m)}</td>
                    <td className="num">{fmt(run.training_load)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  )
}
