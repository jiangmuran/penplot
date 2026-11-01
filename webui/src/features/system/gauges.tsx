import type { LucideIcon } from 'lucide-react'
import * as React from 'react'
import { cn } from '@/lib/cn'

export type GaugeTone = 'accent' | 'green' | 'orange' | 'red' | 'gray'

const toneText: Record<GaugeTone, string> = {
  accent: 'text-accent',
  green: 'text-green',
  orange: 'text-orange',
  red: 'text-red',
  gray: 'text-gray',
}
const toneBadge: Record<GaugeTone, string> = {
  accent: 'bg-accent/15 text-accent',
  green: 'bg-green/15 text-on-tint-green',
  orange: 'bg-orange/15 text-on-tint-orange',
  red: 'bg-red/15 text-on-tint-red',
  gray: 'bg-fill text-secondary-label',
}

/** Status card: icon + label, big value, sub line, 60-sample sparkline (02-ux §3.11). */
export function GaugeCard({
  label, icon: Icon, value, unit, sub, tone = 'accent', history, max = 100, badge, loading,
}: {
  label: string
  icon: LucideIcon
  value: string
  unit?: string
  sub?: React.ReactNode
  tone?: GaugeTone
  history: number[]
  /** Sparkline y-axis maximum (values are clamped). */
  max?: number
  badge?: string
  loading?: boolean
}) {
  return (
    <section aria-label={label} className="flex min-w-0 flex-col overflow-hidden rounded-lg bg-bg-grouped-secondary shadow-sm">
      <div className="flex items-center gap-1.5 px-3.5 pt-3 md:px-4">
        <Icon className={cn('size-4 shrink-0', toneText[tone])} aria-hidden strokeWidth={2.25} />
        <h3 className="truncate text-[12px] font-medium text-secondary-label">{label}</h3>
        {badge ? <span className={cn('ml-auto shrink-0 rounded-full px-1.5 text-[12px] font-semibold', toneBadge[tone])}>{badge}</span> : null}
      </div>
      <p className={cn('px-3.5 pt-1 text-title2 font-semibold tabular-nums text-label md:px-4', loading && 'text-tertiary-label')} aria-live="off">
        {value}
        {unit ? <span className="ml-0.5 text-callout font-normal text-secondary-label">{unit}</span> : null}
      </p>
      <p className="min-h-[1.3em] truncate px-3.5 text-footnote tabular-nums text-secondary-label md:px-4">{sub}</p>
      {history.length < 3 ? (
        <p className="mt-1.5 flex items-center gap-1.5 px-3.5 pb-3 text-[12px] text-secondary-label md:px-4">
          <span className="size-1.5 rounded-full bg-current opacity-60 motion-safe:animate-pulse" aria-hidden />
          趋势收集中…
        </p>
      ) : (
        <Sparkline values={history} max={max} className={cn('mt-2 h-8 w-full md:h-10', toneText[tone])} label={`${label} 最近 ${history.length} 次采样的趋势`} />
      )}
    </section>
  )
}

export function Sparkline({ values, max = 100, className, label }: { values: number[]; max?: number; className?: string; label?: string }) {
  const id = React.useId()
  const W = 120
  const H = 40
  const pts = values.slice(-60)
  // fill the width while history is short, then scroll at 60 samples
  const n = Math.max(pts.length, 12)
  if (pts.length < 2) {
    // not enough history yet: a dashed baseline at the current value
    const yy = pts.length ? H - 2 - (Math.max(0, Math.min(max, pts[0])) / max) * (H - 6) : H - 2
    return (
      <svg className={className} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={`${label ?? ''}（正在收集数据）`}>
        <path d={`M0 ${yy} L${W} ${yy}`} stroke="currentColor" strokeOpacity={0.45} strokeWidth={1.5} strokeDasharray="3 4" vectorEffect="non-scaling-stroke" />
      </svg>
    )
  }
  const step = W / (n - 1)
  const off = n - pts.length
  const y = (v: number) => H - 2 - (Math.max(0, Math.min(max, v)) / max) * (H - 6)
  const d = pts.map((v, i) => `${i ? 'L' : 'M'}${((off + i) * step).toFixed(1)} ${y(v).toFixed(1)}`).join(' ')
  const area = `${d} L${W} ${H} L${(off * step).toFixed(1)} ${H} Z`
  return (
    <svg className={className} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={label}>
      <defs>
        <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="currentColor" stopOpacity="0.28" />
          <stop offset="1" stopColor="currentColor" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${id})`} />
      <path d={d} fill="none" stroke="currentColor" strokeWidth={1.5} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
    </svg>
  )
}

/** Four signal bars for WiFi dBm (−50 excellent … −85 bad). */
export function SignalBars({ dbm, className }: { dbm: number | null | undefined; className?: string }) {
  const level = dbm == null ? 0 : dbm >= -55 ? 4 : dbm >= -65 ? 3 : dbm >= -75 ? 2 : dbm >= -85 ? 1 : 0
  const tone = level >= 3 ? 'bg-green' : level === 2 ? 'bg-orange' : 'bg-red'
  return (
    <span className={cn('inline-flex h-3.5 items-end gap-[2px]', className)} role="img" aria-label={dbm == null ? '无信号数据' : `信号 ${level}/4 格`}>
      {[1, 2, 3, 4].map((b) => (
        <span key={b} className={cn('w-[3px] rounded-[1px]', b <= level ? tone : 'bg-fill')} style={{ height: `${25 * b}%` }} />
      ))}
    </span>
  )
}
