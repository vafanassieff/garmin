import { createFileRoute, Link } from '@tanstack/react-router'

import { api } from '#src/api/client.ts'
import { SLEEP_PERIODS } from '#src/api/periods.ts'
import {
  LineChart,
  RangeColumns,
  SegmentedBar,
  StackedColumns,
  shortDay,
} from '#src/components/charts.tsx'
import { clock, dayLabel, fmt, hours, longDay } from '#src/components/format.ts'
import { STAGES, stageParts } from '#src/components/parts.ts'
import type { SleepAverages, SleepNight } from '#src/stats.ts'

// Sleep: the last night in detail (its stages, its HRV against Garmin's baseline), the period's
// averages against the period before, the stages and the schedule night by night, the score, HRV,
// resting HR and body battery at wake time
type Period = (typeof SLEEP_PERIODS)[number]

export const Route = createFileRoute('/sleep')({
  // ?days= is optional: 30 by default
  validateSearch: (search: Record<string, unknown>): { days?: Period } => {
    const asked = search['days']
    const days = SLEEP_PERIODS.find(
      (period) => period === asked || (typeof period === 'number' && period === Number(asked))
    )
    return days === undefined || days === 30 ? {} : { days }
  },
  loaderDeps: ({ search }) => ({ days: search.days ?? 30 }),
  loader: ({ deps }) => api.web.sleep({ days: deps.days }),
  head: () => ({ meta: [{ title: 'Garmin · sommeil' }] }),
  component: Sleep,
})

const PERIOD_LABEL: Record<Period, string> = {
  30: '30 nuits',
  90: '90 nuits',
  365: '1 an',
  all: 'Tout',
}
const AVERAGE_LABEL: Record<Period, string> = {
  30: '30 nuits',
  90: '90 nuits',
  365: '1 an',
  all: 'tout l’historique',
}
// Nothing before the whole history: no comparison
const BEFORE_LABEL: Record<Period, string | null> = {
  30: 'aux 30 nuits d’avant',
  90: 'aux 90 nuits d’avant',
  365: 'à l’année d’avant',
  all: null,
}

// Past 120 nights, a column per night is too thin: a column per week, its nights' average
interface Column {
  readonly key: string
  readonly label: string
  readonly deep_s: number
  readonly light_s: number
  readonly rem_s: number
  readonly awake_s: number
  readonly bed_min: number | null
  readonly wake_min: number | null
  // From falling asleep to waking, by the timestamps (a DST night is an hour off the clock)
  readonly span_min: number | null
}

const average = (values: ReadonlyArray<number | null>) => {
  const known = values.filter((value): value is number => value !== null)
  return known.length === 0 ? null : known.reduce((a, b) => a + b, 0) / known.length
}

const span = (night: SleepNight) =>
  night.sleep_start === null || night.sleep_end === null
    ? null
    : (Date.parse(night.sleep_end) - Date.parse(night.sleep_start)) / 60_000

const columns = (nights: ReadonlyArray<SleepNight>, weekly: boolean): Array<Column> => {
  if (!weekly) {
    return nights.map((night) => ({
      key: night.day,
      label: `Nuit du ${dayLabel(night.day)}`,
      deep_s: night.deep_s ?? 0,
      light_s: night.light_s ?? 0,
      rem_s: night.rem_s ?? 0,
      awake_s: night.awake_s ?? 0,
      bed_min: night.bed_min,
      wake_min: night.wake_min,
      span_min: span(night),
    }))
  }
  const weeks = new Map<string, Array<SleepNight>>()
  for (const night of nights) {
    const date = new Date(`${night.day}T00:00:00Z`)
    date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7))
    const monday = date.toISOString().slice(0, 10)
    const week = weeks.get(monday)
    if (week === undefined) weeks.set(monday, [night])
    else week.push(night)
  }
  return [...weeks].map(([monday, week]) => {
    const slept = week.filter((night) => night.sleep_s !== null)
    return {
      key: monday,
      label: `Semaine du ${shortDay(monday)} (moyenne de ${slept.length} nuit${slept.length > 1 ? 's' : ''})`,
      deep_s: average(slept.map((night) => night.deep_s)) ?? 0,
      light_s: average(slept.map((night) => night.light_s)) ?? 0,
      rem_s: average(slept.map((night) => night.rem_s)) ?? 0,
      awake_s: average(slept.map((night) => night.awake_s)) ?? 0,
      bed_min: average(slept.map((night) => night.bed_min)),
      wake_min: average(slept.map((night) => night.wake_min)),
      span_min: average(slept.map((night) => span(night))),
    }
  })
}

const STAGE_SERIES = STAGES.map((stage) => ({
  key: stage.key,
  label: stage.label,
  color: stage.color,
  value: (column: Column) => column[`${stage.key}_s`] / 3600,
}))

const HRV_STATUS: Record<string, string> = {
  BALANCED: 'équilibrée',
  UNBALANCED: 'déséquilibrée',
  LOW: 'basse',
  POOR: 'faible',
  NONE: '–',
}

function Change({
  now,
  before,
  format,
  same = 0.5,
}: {
  readonly now: number | null
  readonly before: number | null
  readonly format: (value: number) => string
  // Under this difference, the two are the same (half a point; 30 s for a duration)
  readonly same?: number
}) {
  if (now === null || before === null) return <div className="delta">–</div>
  const diff = now - before
  if (Math.abs(diff) < same) return <div className="delta">= la période d'avant</div>
  return (
    <div className="delta">
      {diff > 0 ? '▲' : '▼'} {format(Math.abs(diff))} vs la période d'avant
    </div>
  )
}

function Averages({
  now,
  before,
}: {
  readonly now: SleepAverages
  readonly before: SleepAverages
}) {
  return (
    <div className="grid cols-4">
      <div className="card tile">
        <div className="label">Durée moyenne</div>
        <div className="value">{hours(now.sleep_s)}</div>
        <Change now={now.sleep_s} before={before.sleep_s} format={(v) => hours(v)} same={30} />
      </div>
      <div className="card tile">
        <div className="label">Score moyen</div>
        <div className="value">
          {fmt(now.sleep_score)}
          <small>/ 100</small>
        </div>
        <Change now={now.sleep_score} before={before.sleep_score} format={(v) => fmt(v)} />
      </div>
      <div className="card tile">
        <div className="label">Coucher · lever moyens</div>
        <div className="value">
          {now.bed_min === null ? '–' : clock(now.bed_min)}
          <small>→ {now.wake_min === null ? '–' : clock(now.wake_min)}</small>
        </div>
        <div className="delta">
          {now.bed_spread_min === null
            ? '–'
            : `coucher à ± ${fmt(now.bed_spread_min)} min près${now.bed_spread_min <= 30 ? ', régulier' : ''}`}
        </div>
      </div>
      <div className="card tile">
        <div className="label">Profond · paradoxal</div>
        <div className="value">
          {fmt(now.deep_pct)}
          <small>%</small> · {fmt(now.rem_pct)}
          <small>%</small>
        </div>
        <div className="delta">du temps endormi · {fmt(now.nights)} nuits mesurées</div>
      </div>
    </div>
  )
}

function Sleep() {
  const view = Route.useLoaderData()
  const days = Route.useSearch().days ?? 30
  const night = view.last
  const weekly = view.days > 120
  const cols = columns(view.nights, weekly)
  const line = (value: (night: SleepNight) => number | null) =>
    view.nights.map((n) => ({
      key: n.day,
      label: dayLabel(n.day),
      tick: shortDay(n.day),
      value: value(n),
    }))
  const inBaseline =
    night?.hrv !== null &&
    night?.hrv !== undefined &&
    night.hrv_baseline_low !== null &&
    night.hrv_baseline_high !== null
      ? night.hrv >= night.hrv_baseline_low && night.hrv <= night.hrv_baseline_high
      : null

  return (
    <main>
      <div className="heading">
        <div>
          <h1>Sommeil</h1>
          <p className="sub">
            La nuit compte pour le jour où elle finit, comme dans Garmin Connect
          </p>
        </div>
        <nav className="periods" aria-label="Période">
          {SLEEP_PERIODS.map((period) => (
            <Link
              key={period}
              to="/sleep"
              search={period === 30 ? {} : { days: period }}
              // The selected period (the router marks its active links too, by exact search below)
              className={period === days ? 'on' : undefined}
              // The search compared whole: 30 (no ?days) is not current on ?days=90. The router
              // compares the raw URL: aria-current from the validated period (a typed ?days=30)
              activeOptions={{ exact: true, includeSearch: true }}
              aria-current={period === days ? 'page' : undefined}
            >
              {PERIOD_LABEL[period]}
            </Link>
          ))}
        </nav>
      </div>

      <section className="card" style={{ marginTop: 0 }}>
        <h2>Dernière nuit</h2>
        {night === null ? (
          <p className="note muted">
            Pas encore de nuit en base : connecte Garmin sur la page{' '}
            <Link to="/garmin">Connexion Garmin</Link>.
          </p>
        ) : (
          <>
            <p className="sub">{longDay(night.day)}</p>
            <div className="hero">{hours(night.sleep_s)}</div>
            <div className="facts">
              <div>
                <div className="label">Score</div>
                <div className="value">
                  {fmt(night.sleep_score)}
                  <small>/ 100</small>
                </div>
              </div>
              <div>
                <div className="label">Coucher → lever</div>
                <div className="value">
                  {night.bed_min === null ? '–' : clock(night.bed_min)} →{' '}
                  {night.wake_min === null ? '–' : clock(night.wake_min)}
                </div>
              </div>
              <div>
                <div className="label">HRV de la nuit</div>
                <div className="value">
                  {fmt(night.hrv)}
                  <small>ms</small>
                </div>
                <div className="note muted">
                  {night.hrv_baseline_low !== null && night.hrv_baseline_high !== null
                    ? `plage habituelle ${fmt(night.hrv_baseline_low)}–${fmt(night.hrv_baseline_high)}${inBaseline === false ? ', en dehors' : ''}`
                    : (HRV_STATUS[night.hrv_status ?? 'NONE'] ?? night.hrv_status)}
                </div>
              </div>
              <div>
                <div className="label">FC au repos</div>
                <div className="value">
                  {fmt(night.resting_hr)}
                  <small>bpm</small>
                </div>
              </div>
              <div>
                <div className="label">Respiration</div>
                <div className="value">
                  {fmt(night.respiration_avg)}
                  <small>/min</small>
                </div>
              </div>
              <div>
                <div className="label">SpO2</div>
                <div className="value">
                  {fmt(night.spo2_avg)}
                  <small>%</small>
                </div>
              </div>
              <div>
                <div className="label">Body battery au réveil</div>
                <div className="value">
                  {fmt(night.body_battery_wake)}
                  <small>/ 100</small>
                </div>
              </div>
              {night.nap_s !== null && night.nap_s > 0 ? (
                <div>
                  <div className="label">Siestes</div>
                  <div className="value">{hours(night.nap_s)}</div>
                </div>
              ) : null}
            </div>
            <div style={{ marginTop: 16 }}>
              <SegmentedBar parts={stageParts(night)} format={hours} title="Phases de la nuit" />
            </div>
          </>
        )}
      </section>

      <section>
        <h2>Moyennes, {AVERAGE_LABEL[days]}</h2>
        {BEFORE_LABEL[days] === null ? (
          <p className="sub">Depuis la première nuit mesurée</p>
        ) : (
          <p className="sub">Comparées {BEFORE_LABEL[days]}</p>
        )}
        <Averages now={view.averages} before={view.previous} />
      </section>

      <section className="card">
        <h2>Phases {weekly ? 'par semaine (moyenne par nuit)' : 'par nuit'} (h)</h2>
        <p className="sub">Le temps passé dans chaque phase, de bas en haut</p>
        <StackedColumns
          rows={cols}
          series={STAGE_SERIES}
          x={(column) => column.key}
          label={(column) => column.label}
          unit="h"
          title="Phases de sommeil"
        />
      </section>

      <section className="card">
        <h2>Horaires</h2>
        <p className="sub">
          De l'endormissement au réveil{weekly ? ', moyenne de chaque semaine' : ''} · le soir en
          haut
        </p>
        <RangeColumns
          rows={cols.map((column) => ({
            key: column.key,
            label: column.label,
            from: column.bed_min,
            to: column.wake_min,
            minutes: column.span_min,
          }))}
          color="var(--series-1)"
          clock={clock}
          title="Heures de coucher et de lever"
        />
      </section>

      <div className="grid cols-2" style={{ marginTop: 14 }}>
        <section className="card" style={{ marginTop: 0 }}>
          <h2>HRV (ms)</h2>
          <p className="sub">La bande : la plage habituelle selon Garmin</p>
          <LineChart
            points={view.nights.map((n) => ({
              key: n.day,
              label: dayLabel(n.day),
              tick: shortDay(n.day),
              value: n.hrv,
              lo: n.hrv_baseline_low,
              hi: n.hrv_baseline_high,
            }))}
            color="var(--series-1)"
            format={(v) => fmt(v)}
            title="HRV"
            bandLabel="plage habituelle"
            height={140}
          />
        </section>
        <section className="card" style={{ marginTop: 0 }}>
          <h2>Score de sommeil</h2>
          <p className="sub">Sur 100</p>
          <LineChart
            points={line((n) => n.sleep_score)}
            color="var(--series-1)"
            format={(v) => fmt(v)}
            title="Score"
            height={140}
          />
        </section>
        <section className="card" style={{ marginTop: 0 }}>
          <h2>FC au repos (bpm)</h2>
          <p className="sub">Plus bas, mieux récupéré</p>
          <LineChart
            points={line((n) => n.resting_hr)}
            color="var(--series-1)"
            format={(v) => fmt(v)}
            title="FC au repos"
            height={140}
          />
        </section>
        <section className="card" style={{ marginTop: 0 }}>
          <h2>Body battery au réveil</h2>
          <p className="sub">Sur 100</p>
          <LineChart
            points={line((n) => n.body_battery_wake)}
            color="var(--series-1)"
            format={(v) => fmt(v)}
            title="Body battery au réveil"
            height={140}
          />
        </section>
      </div>
    </main>
  )
}
