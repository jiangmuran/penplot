/** Appearance preferences (设置 › 通用). Stored in localStorage; applied in index.html before paint. */
export type ThemePref = 'system' | 'light' | 'dark'
export type AccentPref = 'blue' | 'purple' | 'pink' | 'orange' | 'green' | 'indigo' | 'teal'
export type DensityPref = 'auto' | 'compact' | 'comfortable'

const root = () => document.documentElement

export function getTheme(): ThemePref {
  const v = localStorage.getItem('penplot.theme')
  return v === 'light' || v === 'dark' ? v : 'system'
}
export function setTheme(t: ThemePref) {
  if (t === 'system') {
    localStorage.removeItem('penplot.theme')
    delete root().dataset.theme
  } else {
    localStorage.setItem('penplot.theme', t)
    root().dataset.theme = t
  }
}
export function getAccent(): AccentPref {
  return (localStorage.getItem('penplot.accent') as AccentPref | null) ?? 'blue'
}
export function setAccent(a: AccentPref) {
  localStorage.setItem('penplot.accent', a)
  root().dataset.accent = a
}
export function getDensity(): DensityPref {
  return (localStorage.getItem('penplot.density') as DensityPref | null) ?? 'auto'
}
export function setDensity(d: DensityPref) {
  if (d === 'auto') {
    localStorage.removeItem('penplot.density')
    delete root().dataset.density
  } else {
    localStorage.setItem('penplot.density', d)
    root().dataset.density = d
  }
}
/** Apply stored prefs at boot. public/theme-init.js already did theme/accent before
 * first paint; repeat them here so they still apply if that script was blocked. */
export function applyStoredPrefs() {
  const t = getTheme()
  if (t !== 'system') root().dataset.theme = t
  const a = localStorage.getItem('penplot.accent')
  if (a) root().dataset.accent = a
  const d = getDensity()
  if (d !== 'auto') root().dataset.density = d
}
/** Resolved current scheme. */
