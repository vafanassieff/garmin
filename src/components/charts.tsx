import { useEffect, useState } from 'react'

import { fmt as format } from './format.ts'

// The web pages' charts, plain SVG: thin marks, recessive axes, a hover readout, a table view (the
// values are reachable without the pointer). Colors come from the CSS tokens (styles.css), light
// and dark.

// The container's width in pixels: the charts draw at their real size (text stays 11px). A
// callback ref: a container that appears later (data arriving on navigation) is measured too.
const useWidth = (fallback: number) => {
  const [element, setElement] = useState<HTMLDivElement | null>(null)
  const [width, setWidth] = useState(fallback)
  useEffect(() => {
    if (element === null) return
    const observer = new ResizeObserver(([entry]) => {
      if (entry !== undefined) setWidth(Math.max(200, Math.round(entry.contentRect.width)))
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [element])
  return [setElement, width] as const
}

// One tab stop per chart: the left and right arrows step through its marks (the first press lands
// on `start`, the latest mark with data), Home and End jump. With a modifier, the key is the
// browser's (Alt+← goes back).
const arrowKeys =
  (count: number, hover: number | null, setHover: (index: number | null) => void, start: number) =>
  (event: React.KeyboardEvent) => {
    if (event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return
    const step: Record<string, (from: number) => number> = {
      ArrowLeft: (from) => from - 1,
      ArrowRight: (from) => from + 1,
      Home: () => 0,
      End: () => count - 1,
    }
    const move = step[event.key]
    if (move === undefined || count === 0) return
    event.preventDefault()
    const arrow = event.key === 'ArrowLeft' || event.key === 'ArrowRight'
    const next = hover === null && arrow ? start : move(hover ?? start)
    setHover(Math.max(0, Math.min(count - 1, next)))
  }

// What the hovered or focused mark says, for screen readers (the tooltip is only seen)
function Readout({ text }: { readonly text: string }) {
  return (
    <div className="sr-only" aria-live="polite">
      {text}
    </div>
  )
}

const niceMax = (value: number) => {
  if (value <= 0) return 1
  const step = 10 ** Math.floor(Math.log10(value))
  // Halves stay round: the axis shows 0, max / 2, max
  for (const factor of [1, 1.2, 1.6, 2, 2.4, 3, 4, 5, 6, 8, 10]) {
    if (factor * step >= value) return factor * step
  }
  return 10 * step
}

export const shortDay = (day: string) =>
  new Date(`${day}T12:00:00Z`).toLocaleDateString('fr-FR', {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  })

const fmt = (value: number, digits = 1) => format(value, digits)

// Every n-th label, so that at most `max` of them show
const labelEvery = (count: number, max: number) => Math.max(1, Math.ceil(count / max))

function Tooltip({
  left,
  top,
  children,
}: {
  readonly left: number
  readonly top: number
  readonly children: React.ReactNode
}) {
  // Kept inside the chart: near an edge, it grows inwards
  const shift = left < 18 ? '-12%' : left > 82 ? '-88%' : '-50%'
  return (
    <div
      className="tooltip"
      style={{
        left: `${left}%`,
        top: `${top}%`,
        transform: `translate(${shift}, calc(-100% - 10px))`,
      }}
    >
      {children}
    </div>
  )
}

export interface StackSeries<Row> {
  readonly key: string
  readonly label: string
  readonly color: string
  readonly value: (row: Row) => number
}

// Columns from one baseline, segments split by a 2px surface gap, the top one rounded
export function StackedColumns<Row>({
  rows,
  series,
  x,
  label = (row) => `Semaine du ${shortDay(x(row))}`,
  tick = (row) => shortDay(x(row)),
  unit,
  title,
  digits = 1,
  height = 220,
}: {
  readonly rows: ReadonlyArray<Row>
  readonly series: ReadonlyArray<StackSeries<Row>>
  readonly x: (row: Row) => string
  // The tooltip's and the table's name of a column, and its axis label
  readonly label?: (row: Row) => string
  readonly tick?: (row: Row) => string
  readonly unit: string
  readonly title: string
  readonly digits?: number
  readonly height?: number
}) {
  const [hover, setHover] = useState<number | null>(null)
  const [ref, W] = useWidth(640)
  const H = height
  const pad = { top: 12, right: 8, bottom: 24, left: 34 }
  const plotW = W - pad.left - pad.right
  const plotH = H - pad.top - pad.bottom
  const totals = rows.map((row) => series.reduce((sum, s) => sum + s.value(row), 0))
  const max = niceMax(Math.max(...totals, 0))
  const ticks = [0, max / 2, max]
  const band = plotW / Math.max(rows.length, 1)
  const barW = Math.max(2, Math.min(24, band * 0.6))
  const every = labelEvery(rows.length, Math.max(2, Math.floor(plotW / 64)))
  const y = (value: number) => pad.top + plotH - (value / max) * plotH
  const hovered = hover === null ? undefined : rows[hover]

  return (
    <div className="chart" ref={ref}>
      {series.length > 1 ? (
        <div className="legend" aria-hidden="true">
          {series.map((s) => (
            <span key={s.key}>
              <i style={{ background: s.color }} />
              {s.label}
            </span>
          ))}
        </div>
      ) : null}
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`${title} : flèches gauche et droite pour lire les valeurs`}
        tabIndex={0}
        onKeyDown={arrowKeys(rows.length, hover, setHover, rows.length - 1)}
        onBlur={() => setHover(null)}
      >
        {ticks.map((value) => (
          <g key={value}>
            <line
              className={value === 0 ? 'baseline' : 'gridline'}
              x1={pad.left}
              x2={W - pad.right}
              y1={y(value)}
              y2={y(value)}
            />
            <text className="tick" x={pad.left - 6} y={y(value) + 4} textAnchor="end">
              {fmt(value)}
            </text>
          </g>
        ))}
        {rows.map((row, index) => {
          const cx = pad.left + band * index + band / 2
          let base = 0
          const values = series.map((s) => s.value(row))
          const topIndex = values.findLastIndex((value) => value > 0)
          return (
            <g key={x(row)} className={`mark${hover === index ? ' on' : ''}`}>
              {series.map((s, si) => {
                const value = values[si] ?? 0
                if (value <= 0) return null
                const y0 = y(base)
                base += value
                const y1 = y(base)
                // The 2px gap: each segment above another gives up its bottom 2px
                const bottom = si > 0 && base - value > 0 ? y0 - 2 : y0
                const h = Math.max(bottom - y1, 0.5)
                const left = cx - barW / 2
                if (si !== topIndex) {
                  return <rect key={s.key} x={left} y={y1} width={barW} height={h} fill={s.color} />
                }
                const r = Math.min(4, h, barW / 2)
                return (
                  <path
                    key={s.key}
                    fill={s.color}
                    d={`M${left},${bottom} V${y1 + r} Q${left},${y1} ${left + r},${y1} H${left + barW - r} Q${left + barW},${y1} ${left + barW},${y1 + r} V${bottom} Z`}
                  />
                )
              })}
              {(rows.length - 1 - index) % every === 0 ? (
                <text className="tick" x={cx} y={H - 6} textAnchor="middle">
                  {tick(row)}
                </text>
              ) : null}
              <rect
                className="hit"
                x={pad.left + band * index}
                y={pad.top}
                width={band}
                height={plotH}
                onPointerEnter={() => setHover(index)}
                onPointerLeave={() => setHover(null)}
              />
            </g>
          )
        })}
      </svg>
      {hovered !== undefined && hover !== null ? (
        <Tooltip
          left={((pad.left + band * hover + band / 2) / W) * 100}
          top={(y(totals[hover] ?? 0) / H) * 100}
        >
          <div className="when">{label(hovered)}</div>
          {series.map((s) => (
            <div className="r" key={s.key}>
              <i className="key" style={{ background: s.color }} />
              <b>
                {fmt(s.value(hovered), digits)} {unit}
              </b>
              <span>{s.label}</span>
            </div>
          ))}
        </Tooltip>
      ) : null}
      <Readout
        text={
          hovered === undefined
            ? ''
            : `${label(hovered)} : ${series.map((s) => `${s.label} ${fmt(s.value(hovered), digits)} ${unit}`).join(', ')}`
        }
      />
      <details className="table-view">
        <summary>Tableau</summary>
        <table>
          <thead>
            <tr>
              <th />
              {series.map((s) => (
                <th className="num" key={s.key}>
                  {s.label} ({unit})
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={x(row)}>
                <td>{label(row)}</td>
                {series.map((s) => (
                  <td className="num" key={s.key}>
                    {fmt(s.value(row), digits)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  )
}

export interface LinePoint {
  readonly key: string
  // The tooltip's and the table's name of the point (a day, a minute…)
  readonly label: string
  // Its axis label, when shorter than its name
  readonly tick?: string
  readonly value: number | null
  // A band behind the line (Garmin's HRV baseline), where both are known
  readonly lo?: number | null
  readonly hi?: number | null
}

// One measure over evenly spaced points: a 2px line broken where a point has none (or dots, for
// separate events), its last value marked, a crosshair snapping to the nearest point. Two charts
// can share their crosshair (hover, onHover).
export function LineChart({
  points,
  color,
  format,
  title,
  invert = false,
  dots = false,
  height = 110,
  bandLabel,
  hover: controlled,
  onHover,
}: {
  readonly points: ReadonlyArray<LinePoint>
  readonly color: string
  readonly format: (value: number) => string
  readonly title: string
  // Smaller is better (a pace): up is smaller
  readonly invert?: boolean
  readonly dots?: boolean
  readonly height?: number
  readonly bandLabel?: string
  readonly hover?: number | null
  readonly onHover?: (index: number | null) => void
}) {
  const [own, setOwn] = useState<number | null>(null)
  const hover = controlled === undefined ? own : controlled
  const setHover = (index: number | null) => {
    setOwn(index)
    onHover?.(index)
  }
  const [ref, W] = useWidth(320)
  const H = height
  const pad = { top: 10, right: 44, bottom: 18, left: 6 }
  const plotW = W - pad.left - pad.right
  const plotH = H - pad.top - pad.bottom
  const values = points.flatMap((p) => (p.value === null ? [] : [p.value]))
  const bands = points.flatMap((p) =>
    p.lo === undefined || p.lo === null || p.hi === undefined || p.hi === null ? [] : [p.lo, p.hi]
  )
  const lo = Math.min(...values)
  const hi = Math.max(...values)
  const domainLo = Math.min(lo, ...bands)
  const domainHi = Math.max(hi, ...bands)
  const span = domainHi - domainLo || 1
  const min = domainLo - span * 0.12
  const max = domainHi + span * 0.12
  const x = (index: number) =>
    pad.left + (points.length <= 1 ? plotW / 2 : (index / (points.length - 1)) * plotW)
  const y = (value: number) => {
    const ratio = (value - min) / (max - min)
    return pad.top + (invert ? ratio : 1 - ratio) * plotH
  }
  let d = ''
  let open = false
  points.forEach((p, index) => {
    if (p.value === null) {
      open = false
      return
    }
    d += `${open ? 'L' : 'M'}${x(index).toFixed(1)},${y(p.value).toFixed(1)} `
    open = true
  })
  // The band: one closed shape per run of points that have it
  const areas: Array<string> = []
  let run: Array<{ index: number; lo: number; hi: number }> = []
  const flush = () => {
    if (run.length > 1) {
      const top = run.map((p) => `${x(p.index).toFixed(1)},${y(p.hi).toFixed(1)}`)
      const bottom = run.toReversed().map((p) => `${x(p.index).toFixed(1)},${y(p.lo).toFixed(1)}`)
      areas.push(`M${top.join(' L')} L${bottom.join(' L')} Z`)
    }
    run = []
  }
  points.forEach((p, index) => {
    if (p.lo === undefined || p.lo === null || p.hi === undefined || p.hi === null) flush()
    else run.push({ index, lo: p.lo, hi: p.hi })
  })
  flush()
  const lastIndex = points.findLastIndex((p) => p.value !== null)
  const last = points[lastIndex]
  const hovered = hover === null ? undefined : points[hover]

  // The pointer in the plot's own units (the hit area spans the whole chart, the points only the
  // plot between its paddings)
  const onMove = (event: React.PointerEvent<SVGRectElement>) => {
    const box = event.currentTarget.getBoundingClientRect()
    const atX = ((event.clientX - box.left) / box.width) * W
    const ratio = plotW > 0 ? (atX - pad.left) / plotW : 0
    setHover(Math.max(0, Math.min(points.length - 1, Math.round(ratio * (points.length - 1)))))
  }
  const onKey = arrowKeys(points.length, hover, setHover, lastIndex)

  if (values.length === 0) {
    return (
      <div className="chart" ref={ref}>
        <p className="note muted">Pas encore de données.</p>
      </div>
    )
  }
  const every = labelEvery(points.length, Math.max(2, Math.floor(plotW / 90)))
  return (
    <div className="chart" ref={ref}>
      {bandLabel !== undefined && areas.length > 0 ? (
        <div className="legend" aria-hidden="true">
          <span>
            <i className="line" style={{ background: color }} />
            {title}
          </span>
          <span>
            <i className="band" style={{ background: color }} />
            {bandLabel}
          </span>
        </div>
      ) : null}
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`${title} : flèches gauche et droite pour lire les valeurs`}
        tabIndex={0}
        onKeyDown={onKey}
        onBlur={() => setHover(null)}
      >
        {areas.map((area) => (
          <path key={area} d={area} fill={color} fillOpacity={0.12} />
        ))}
        <line className="gridline" x1={pad.left} x2={W - pad.right} y1={y(hi)} y2={y(hi)} />
        <line className="gridline" x1={pad.left} x2={W - pad.right} y1={y(lo)} y2={y(lo)} />
        <text className="tick" x={W - pad.right + 4} y={y(hi) + 4}>
          {format(hi)}
        </text>
        {hi === lo ? null : (
          <text className="tick" x={W - pad.right + 4} y={y(lo) + 4}>
            {format(lo)}
          </text>
        )}
        {dots ? (
          points.map((p, index) =>
            p.value === null ? null : (
              <circle
                key={p.key}
                cx={x(index)}
                cy={y(p.value)}
                r={4}
                fill={color}
                stroke="var(--surface)"
                strokeWidth={2}
              />
            )
          )
        ) : (
          <path className="line" d={d} stroke={color} />
        )}
        {!dots && last?.value !== null && last !== undefined ? (
          <circle
            cx={x(lastIndex)}
            cy={y(last.value)}
            r={4}
            fill={color}
            stroke="var(--surface)"
            strokeWidth={2}
          />
        ) : null}
        {points.map((p, index) =>
          (points.length - 1 - index) % every === 0 ? (
            <text
              key={p.key}
              className="tick"
              x={x(index)}
              y={H - 4}
              textAnchor={index === 0 ? 'start' : index === points.length - 1 ? 'end' : 'middle'}
            >
              {p.tick ?? p.label}
            </text>
          ) : null
        )}
        {hovered !== undefined && hover !== null ? (
          <g>
            <line
              className="crosshair"
              x1={x(hover)}
              x2={x(hover)}
              y1={pad.top}
              y2={pad.top + plotH}
            />
            {hovered.value === null ? null : (
              <circle
                cx={x(hover)}
                cy={y(hovered.value)}
                r={5}
                fill={color}
                stroke="var(--surface)"
                strokeWidth={2}
              />
            )}
          </g>
        ) : null}
        <rect
          className="hit"
          x={0}
          y={0}
          width={W}
          height={H}
          onPointerMove={onMove}
          onPointerLeave={() => setHover(null)}
        />
      </svg>
      {hovered !== undefined && hover !== null ? (
        <Tooltip left={(x(hover) / W) * 100} top={(pad.top / H) * 100}>
          <div className="when">{hovered.label}</div>
          <div className="r">
            <i className="key" style={{ background: color }} />
            <b>{hovered.value === null ? '–' : format(hovered.value)}</b>
            <span>{title}</span>
          </div>
          {bandLabel !== undefined &&
          hovered.lo !== undefined &&
          hovered.lo !== null &&
          hovered.hi !== undefined &&
          hovered.hi !== null ? (
            <div className="r">
              <i className="key band" style={{ background: color }} />
              <b>
                {format(hovered.lo)}–{format(hovered.hi)}
              </b>
              <span>{bandLabel}</span>
            </div>
          ) : null}
        </Tooltip>
      ) : null}
      <Readout
        text={
          hovered === undefined
            ? ''
            : `${hovered.label} : ${hovered.value === null ? 'pas de donnée' : format(hovered.value)}`
        }
      />
      <details className="table-view">
        <summary>Tableau</summary>
        <table>
          <tbody>
            {points.map((p) => (
              <tr key={p.key}>
                <td>{p.label}</td>
                <td className="num">{p.value === null ? '–' : format(p.value)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  )
}

export interface Range {
  readonly key: string
  readonly label: string
  readonly from: number | null
  readonly to: number | null
  // The real time between the two, in minutes, when the clock changed in between (DST)
  readonly minutes?: number | null
}

// From when to when, one floating column per row on a time-of-day axis that reads downwards (the
// evening on top): bedtimes and wake times. Values are minutes from noon.
export function RangeColumns({
  rows,
  color,
  clock,
  title,
}: {
  readonly rows: ReadonlyArray<Range>
  readonly color: string
  readonly clock: (minutes: number) => string
  readonly title: string
}) {
  const [hover, setHover] = useState<number | null>(null)
  const [ref, W] = useWidth(640)
  const H = 220
  const pad = { top: 10, right: 8, bottom: 24, left: 44 }
  const plotW = W - pad.left - pad.right
  const plotH = H - pad.top - pad.bottom
  const known = rows.filter(
    (row): row is Range & { from: number; to: number } => row.from !== null && row.to !== null
  )
  if (known.length === 0) {
    return (
      <div className="chart" ref={ref}>
        <p className="note muted">Pas encore de données.</p>
      </div>
    )
  }
  const first = Math.floor((Math.min(...known.map((row) => row.from)) - 30) / 120) * 120
  const last = Math.ceil((Math.max(...known.map((row) => row.to)) + 30) / 120) * 120
  const ticks = Array.from({ length: (last - first) / 120 + 1 }, (_, index) => first + index * 120)
  const y = (minutes: number) => pad.top + ((minutes - first) / (last - first)) * plotH
  const band = plotW / Math.max(rows.length, 1)
  const barW = Math.max(2, Math.min(24, band * 0.6))
  const every = labelEvery(rows.length, Math.max(2, Math.floor(plotW / 64)))
  const hovered = hover === null ? undefined : rows[hover]
  const length = (row: Range) => {
    if (row.from === null || row.to === null) return '–'
    const minutes = Math.round(row.minutes ?? row.to - row.from)
    return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')}`
  }

  return (
    <div className="chart" ref={ref}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`${title} : flèches gauche et droite pour lire les valeurs`}
        tabIndex={0}
        onKeyDown={arrowKeys(
          rows.length,
          hover,
          setHover,
          rows.findLastIndex((row) => row.from !== null && row.to !== null)
        )}
        onBlur={() => setHover(null)}
      >
        {ticks.map((tick) => (
          <g key={tick}>
            <line className="gridline" x1={pad.left} x2={W - pad.right} y1={y(tick)} y2={y(tick)} />
            <text className="tick" x={pad.left - 6} y={y(tick) + 4} textAnchor="end">
              {clock(tick)}
            </text>
          </g>
        ))}
        {rows.map((row, index) => {
          const cx = pad.left + band * index + band / 2
          const top = row.from === null ? null : y(row.from)
          const bottom = row.to === null ? null : y(row.to)
          return (
            <g key={row.key} className={`mark${hover === index ? ' on' : ''}`}>
              {top !== null && bottom !== null ? (
                <rect
                  x={cx - barW / 2}
                  y={top}
                  width={barW}
                  height={Math.max(bottom - top, 1)}
                  rx={Math.min(4, barW / 2)}
                  fill={color}
                />
              ) : null}
              {(rows.length - 1 - index) % every === 0 ? (
                <text className="tick" x={cx} y={H - 6} textAnchor="middle">
                  {shortDay(row.key)}
                </text>
              ) : null}
              <rect
                className="hit"
                x={pad.left + band * index}
                y={pad.top}
                width={band}
                height={plotH}
                onPointerEnter={() => setHover(index)}
                onPointerLeave={() => setHover(null)}
              />
            </g>
          )
        })}
      </svg>
      {hovered !== undefined && hover !== null && hovered.from !== null && hovered.to !== null ? (
        <Tooltip
          left={((pad.left + band * hover + band / 2) / W) * 100}
          top={(y(hovered.from) / H) * 100}
        >
          <div className="when">{hovered.label}</div>
          <div className="r">
            <b>{clock(hovered.from)}</b>
            <span>coucher</span>
          </div>
          <div className="r">
            <b>{clock(hovered.to)}</b>
            <span>lever</span>
          </div>
          <div className="r">
            <b>{length(hovered)}</b>
            <span>de la première à la dernière minute de sommeil</span>
          </div>
        </Tooltip>
      ) : null}
      <Readout
        text={
          hovered === undefined
            ? ''
            : hovered.from === null || hovered.to === null
              ? `${hovered.label} : pas de données`
              : `${hovered.label} : couché ${clock(hovered.from)}, levé ${clock(hovered.to)}, ${length(hovered)}`
        }
      />
      <details className="table-view">
        <summary>Tableau</summary>
        <table>
          <thead>
            <tr>
              <th>Nuit</th>
              <th className="num">Coucher</th>
              <th className="num">Lever</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key}>
                <td>{row.label}</td>
                <td className="num">{row.from === null ? '–' : clock(row.from)}</td>
                <td className="num">{row.to === null ? '–' : clock(row.to)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  )
}

export interface Part {
  readonly key: string
  readonly label: string
  readonly value: number
  readonly color: string
  // The label's ink on that fill (white, or near-black on the light fills)
  readonly ink: string
}

// One whole split into its parts (a night's stages, time per HR zone): a tall bar, each part's
// share printed inside when it fits, the legend naming the parts in order
export function SegmentedBar({
  parts,
  format,
  title,
}: {
  readonly parts: ReadonlyArray<Part>
  readonly format: (value: number) => string
  readonly title: string
}) {
  const [hover, setHover] = useState<string | null>(null)
  const total = parts.reduce((sum, part) => sum + Math.max(part.value, 0), 0)
  if (total <= 0) return <p className="note muted">Pas de données.</p>
  const share = (value: number) => Math.round((value / total) * 100)
  const describe = (part: Part) => `${part.label} : ${format(part.value)} (${share(part.value)} %)`
  const hovered = parts.find((part) => part.key === hover)
  return (
    <div className="segmented">
      <div className="legend" aria-hidden="true">
        {parts.map((part) => (
          <span key={part.key}>
            <i style={{ background: part.color }} />
            {part.label}
          </span>
        ))}
      </div>
      <div className="bar" role="group" aria-label={title}>
        {parts.map((part) =>
          part.value <= 0 ? null : (
            <div
              key={part.key}
              className={`part${hover === part.key ? ' on' : ''}`}
              style={{ flexGrow: part.value, background: part.color, color: part.ink }}
              role="img"
              tabIndex={0}
              aria-label={describe(part)}
              onPointerEnter={() => setHover(part.key)}
              onPointerLeave={() => setHover(null)}
              onFocus={() => setHover(part.key)}
              onBlur={() => setHover(null)}
            >
              {share(part.value) >= 9 ? `${share(part.value)} %` : ''}
            </div>
          )
        )}
      </div>
      <div className="readout note" aria-live="polite">
        {hovered === undefined ? ' ' : describe(hovered)}
      </div>
      <details className="table-view">
        <summary>Tableau</summary>
        <table>
          <tbody>
            {parts.map((part) => (
              <tr key={part.key}>
                <td>{part.label}</td>
                <td className="num">{format(part.value)}</td>
                <td className="num">{share(part.value)} %</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  )
}

// The route, drawn on a local plane (no map tiles: nothing leaves the app): a 2px line, the start
// a ringed hollow dot, the finish a filled one
export function RouteMap({
  points,
  title,
}: {
  readonly points: ReadonlyArray<readonly [number, number]>
  readonly title: string
}) {
  const [ref, W] = useWidth(480)
  if (points.length < 2) return <p className="note muted">Pas de tracé GPS.</p>
  const lat0 = ((points[0]?.[0] ?? 0) * Math.PI) / 180
  const projected = points.map(([lat, lon]) => [lon * Math.cos(lat0), -lat] as const)
  const xs = projected.map((p) => p[0])
  const ys = projected.map((p) => p[1])
  const minX = Math.min(...xs)
  const maxX = Math.max(...xs)
  const minY = Math.min(...ys)
  const maxY = Math.max(...ys)
  const spanX = maxX - minX || 1e-6
  const spanY = maxY - minY || 1e-6
  const margin = 14
  const H = Math.round(Math.min(360, Math.max(180, (W * spanY) / spanX)))
  const scale = Math.min((W - margin * 2) / spanX, (H - margin * 2) / spanY)
  const offsetX = (W - spanX * scale) / 2
  const offsetY = (H - spanY * scale) / 2
  const at = ([px, py]: readonly [number, number]) =>
    [offsetX + (px - minX) * scale, offsetY + (py - minY) * scale] as const
  const path = projected
    .map((p, index) => {
      const [px, py] = at(p)
      return `${index === 0 ? 'M' : 'L'}${px.toFixed(1)},${py.toFixed(1)}`
    })
    .join(' ')
  const start = at(projected[0] ?? [0, 0])
  const end = at(projected.at(-1) ?? [0, 0])
  return (
    <div className="chart route" ref={ref}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={title}>
        <path className="line" d={path} stroke="var(--series-1)" />
        <circle
          cx={start[0]}
          cy={start[1]}
          r={5}
          fill="var(--surface)"
          stroke="var(--series-1)"
          strokeWidth={2.5}
        />
        <circle
          cx={end[0]}
          cy={end[1]}
          r={5}
          fill="var(--ink)"
          stroke="var(--surface)"
          strokeWidth={2}
        />
      </svg>
      <div className="legend">
        <span>
          <i className="dot hollow" /> départ
        </span>
        <span>
          <i className="dot" /> arrivée
        </span>
      </div>
    </div>
  )
}
