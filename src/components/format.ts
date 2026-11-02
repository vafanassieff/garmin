// How the pages write numbers, durations, paces, days and sports (French, Paris time)

// The thousands separator is a narrow no-break space in every ICU we know of, but not in all of
// them: one character for all, so that the server's HTML and the browser's render agree
export const fmt = (value: number | null | undefined, digits = 0) =>
  value === null || value === undefined
    ? '–'
    : value
        .toLocaleString('fr-FR', { maximumFractionDigits: digits })
        .replaceAll(/[\u00A0\u202F]/gu, '\u202F')

// 2 h 05, from seconds
export const hours = (seconds: number | null | undefined) => {
  if (seconds === null || seconds === undefined) return '–'
  const minutes = Math.round(seconds / 60)
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')}`
}

// 1:02:05 or 42:05, from seconds
export const duration = (seconds: number | null | undefined) => {
  if (seconds === null || seconds === undefined) return '–'
  const whole = Math.round(seconds)
  const h = Math.floor(whole / 3600)
  const m = Math.floor((whole % 3600) / 60)
  const s = String(whole % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`
}

// 5:12, from seconds per km
export const pace = (seconds: number | null | undefined) =>
  seconds === null || seconds === undefined || seconds <= 0 ? '–' : duration(seconds)

// 23:40, from minutes from noon (see stats.ts minutesFromNoon)
export const clock = (minutes: number) => {
  const wrapped = (((Math.round(minutes) + 720) % 1440) + 1440) % 1440
  return `${String(Math.floor(wrapped / 60)).padStart(2, '0')}:${String(wrapped % 60).padStart(2, '0')}`
}

const at = (day: string) => new Date(`${day}T12:00:00Z`)

// mar. 28 oct.
export const dayLabel = (day: string) =>
  at(day).toLocaleDateString('fr-FR', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  })

// mardi 28 octobre
export const longDay = (day: string) =>
  at(day).toLocaleDateString('fr-FR', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  })

// 28/10/2026
export const numericDay = (day: string) => at(day).toLocaleDateString('fr-FR', { timeZone: 'UTC' })

// A stored local time (YYYY-MM-DDTHH:MM:SS) as 08:47
export const localTime = (local: string) => local.slice(11, 16)

const SPORTS: Record<string, string> = {
  running: 'Course',
  trail_running: 'Trail',
  treadmill_running: 'Tapis',
  track_running: 'Piste',
  cycling: 'Vélo',
  road_biking: 'Vélo route',
  mountain_biking: 'VTT',
  gravel_cycling: 'Gravel',
  indoor_cycling: 'Home trainer',
  strength_training: 'Renfo',
  hiking: 'Rando',
  walking: 'Marche',
  indoor_climbing: 'Escalade',
  bouldering: 'Bloc',
  lap_swimming: 'Natation',
  open_water_swimming: 'Eau libre',
  yoga: 'Yoga',
}
export const sport = (key: string) => SPORTS[key] ?? key.replaceAll('_', ' ')
