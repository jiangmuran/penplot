import { cn } from '@/lib/cn'

export interface ProgressProps {
  /** 0–100; null = indeterminate */
  value: number | null
  /** aria-valuetext, e.g. "42%，剩余约 13 分钟" */
  valueText?: string
  label?: string
  className?: string
  tone?: 'accent' | 'green' | 'orange' | 'red' | 'gray'
}

const toneBg = { accent: 'bg-accent', green: 'bg-green', orange: 'bg-orange', red: 'bg-red', gray: 'bg-gray' }
const toneStroke = { accent: 'text-accent', green: 'text-green', orange: 'text-orange', red: 'text-red', gray: 'text-gray' }

/** Linear progress (default 4px; pass h-0.5 for the 2px mini-player bar). */
export function ProgressBar({ value, valueText, label, className, tone = 'accent' }: ProgressProps) {
  const v = value == null ? null : Math.max(0, Math.min(100, value))
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={v ?? undefined}
      aria-valuetext={valueText}
      className={cn('relative h-1 w-full overflow-hidden rounded-full bg-fill', className)}
    >
      <div
        className={cn(
          'absolute inset-y-0 left-0 rounded-full transition-[width] duration-[var(--dur-slow)] ease-standard',
          toneBg[tone],
          v == null && 'w-1/3 motion-safe:animate-[indeterminate_1.2s_var(--ease-standard)_infinite]',
        )}
        style={v == null ? undefined : { width: `${v}%` }}
      />
      <style>{`@keyframes indeterminate{from{transform:translateX(-100%)}to{transform:translateX(300%)}}`}</style>
    </div>
  )
}

/** Circular progress ring. */
export function ProgressRing({
  value, size = 40, stroke = 4, valueText, label, className, tone = 'accent', children,
}: ProgressProps & { size?: number; stroke?: number; children?: React.ReactNode }) {
  const v = value == null ? 25 : Math.max(0, Math.min(100, value))
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={value ?? undefined}
      aria-valuetext={valueText}
      className={cn('relative inline-flex shrink-0 items-center justify-center', className)}
      style={{ width: size, height: size }}
    >
      <svg width={size} height={size} className={cn('-rotate-90', value == null && 'motion-safe:animate-spin')}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={stroke} className="stroke-fill" />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          strokeWidth={stroke}
          stroke="currentColor"
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - v / 100)}
          className={cn(toneStroke[tone], 'transition-[stroke-dashoffset] duration-[var(--dur-slow)] ease-standard')}
        />
      </svg>
      {children ? <div className="absolute inset-0 flex items-center justify-center">{children}</div> : null}
    </div>
  )
}
