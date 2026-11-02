import type { Part } from './charts.tsx'

// The parts of the segmented bars: an activity's time per HR zone (ordinal: one blue, light to
// dark), a night's stages (categorical, slots 1 to 4)

export const zoneParts = (zones: {
  readonly z1_s: number
  readonly z2_s: number
  readonly z3_s: number
  readonly z4_s: number
  readonly z5_s: number
}): Array<Part> =>
  (
    [
      ['z1', 'Z1 récup', zones.z1_s],
      ['z2', 'Z2 endurance', zones.z2_s],
      ['z3', 'Z3 tempo', zones.z3_s],
      ['z4', 'Z4 seuil', zones.z4_s],
      ['z5', 'Z5 VO2max', zones.z5_s],
    ] as const
  ).map(([key, label, value], index) => ({
    key,
    label,
    value,
    color: `var(--zone-${index + 1})`,
    ink: `var(--zone-${index + 1}-ink)`,
  }))

export const STAGES = [
  { key: 'deep', label: 'Profond', color: 'var(--series-1)', ink: '#ffffff' },
  { key: 'light', label: 'Léger', color: 'var(--series-2)', ink: '#ffffff' },
  { key: 'rem', label: 'Paradoxal', color: 'var(--series-3)', ink: '#ffffff' },
  { key: 'awake', label: 'Éveillé', color: 'var(--series-4)', ink: 'var(--series-4-ink)' },
] as const

export const stageParts = (night: {
  readonly deep_s: number | null
  readonly light_s: number | null
  readonly rem_s: number | null
  readonly awake_s: number | null
}): Array<Part> => {
  const values = [night.deep_s, night.light_s, night.rem_s, night.awake_s]
  // A new object per part: STAGES stays as it is
  return STAGES.map((stage, index) => ({
    key: stage.key,
    label: stage.label,
    color: stage.color,
    ink: stage.ink,
    value: values[index] ?? 0,
  }))
}
