/**
 * Recently used paper presets (browser-local). Pages-agent addition.
 * Call `touchRecentPaper(paperId)` whenever a paper is chosen (paper picker, new project, print);
 * 设置 › 纸张预设 pins the last 3 at the top.
 */
const KEY = 'penplot.recentPapers'

export function recentPaperIds(limit = 3): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '[]')
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, limit) : []
  } catch {
    return []
  }
}

export function touchRecentPaper(id: string | null | undefined) {
  if (!id) return
  const next = [id, ...recentPaperIds(10).filter((x) => x !== id)].slice(0, 10)
  try {
    localStorage.setItem(KEY, JSON.stringify(next))
  } catch {
    /* private mode */
  }
}
