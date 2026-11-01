/** Formatting helpers. All numbers shown in UI should use `tabular-nums`. */

/** 252 → "4:12", 3725 → "1:02:05". */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return '—'
  const s = Math.round(seconds)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`
}

/** Spoken-style duration for aria: "约 13 分钟". */
export function formatDurationSpoken(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return '未知'
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))} 秒`
  if (seconds < 3600) return `约 ${Math.round(seconds / 60)} 分钟`
  return `约 ${(seconds / 3600).toFixed(1)} 小时`
}


export function formatNumber(n: number | null | undefined, digits = 2): string {
  if (n == null || !Number.isFinite(n)) return '—'
  return n.toFixed(digits)
}

export function formatBytes(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—'
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let v = n
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${u[i]}`
}

const rtf = typeof Intl !== 'undefined' ? new Intl.RelativeTimeFormat('zh-CN', { numeric: 'auto' }) : null

/** "3 分钟前" / "昨天". Accepts ISO string, epoch ms or seconds. */
export function formatRelative(t: string | number | Date | null | undefined): string {
  if (t == null) return '—'
  const d = toDate(t)
  if (!d) return '—'
  const diff = (d.getTime() - Date.now()) / 1000
  const abs = Math.abs(diff)
  if (!rtf) return d.toLocaleString('zh-CN')
  if (abs < 45) return '刚刚'
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute')
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour')
  if (abs < 86400 * 30) return rtf.format(Math.round(diff / 86400), 'day')
  return d.toLocaleDateString('zh-CN')
}

export function formatTime(t: string | number | Date | null | undefined, withSeconds = true): string {
  const d = t == null ? null : toDate(t)
  if (!d) return '—'
  return d.toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit', second: withSeconds ? '2-digit' : undefined })
}

export function toDate(t: string | number | Date): Date | null {
  if (t instanceof Date) return t
  if (typeof t === 'number') return new Date(t < 1e12 ? t * 1000 : t)
  const d = new Date(t)
  return Number.isNaN(d.getTime()) ? null : d
}

/** File extension incl. compound ones we care about: "a.penplot.json" → ".penplot.json". */
export function fileExt(name: string): string {
  const lower = name.toLowerCase()
  if (lower.endsWith('.penplot.json')) return '.penplot.json'
  const i = lower.lastIndexOf('.')
  return i >= 0 ? lower.slice(i) : ''
}
