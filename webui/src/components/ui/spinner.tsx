import { cn } from '@/lib/cn'

/** Activity indicator (macOS-style spokes). Size in px. */
export function Spinner({ size = 16, className, label = '加载中' }: { size?: number; className?: string; label?: string }) {
  return (
    <svg
      role="status"
      aria-label={label}
      viewBox="0 0 24 24"
      width={size}
      height={size}
      className={cn('shrink-0 animate-spin [animation-duration:900ms] [animation-timing-function:steps(8)]', className)}
    >
      {Array.from({ length: 8 }, (_, i) => (
        <line
          key={i}
          x1="12" y1="3" x2="12" y2="7.5"
          stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"
          opacity={0.25 + (i / 8) * 0.75}
          transform={`rotate(${i * 45} 12 12)`}
        />
      ))}
    </svg>
  )
}
