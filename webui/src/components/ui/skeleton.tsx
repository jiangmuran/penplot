import * as React from 'react'
import { cn } from '@/lib/cn'

/** Placeholder block. Shimmer only when motion is allowed. */
export function Skeleton({ className, ...p }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      aria-hidden
      className={cn(
        'rounded-sm bg-quaternary-fill',
        'motion-safe:animate-shimmer motion-safe:bg-[length:200%_100%] motion-safe:bg-[linear-gradient(90deg,transparent_25%,rgb(var(--fill)/0.08)_50%,transparent_75%)]',
        className,
      )}
      {...p}
    />
  )
}

/** Renders children only after `delay` ms (02-ux §3: skeleton appears only if loading >300ms). */
export function Delayed({ delay = 300, children }: { delay?: number; children: React.ReactNode }) {
  const [show, setShow] = React.useState(false)
  React.useEffect(() => {
    const t = setTimeout(() => setShow(true), delay)
    return () => clearTimeout(t)
  }, [delay])
  return show ? <>{children}</> : null
}

/** A few skeleton list rows inside a grouped card. */
export function SkeletonList({ rows = 4, className }: { rows?: number; className?: string }) {
  return (
    <Delayed>
      <div role="status" aria-label="加载中" className={cn('overflow-hidden rounded-lg bg-bg-grouped-secondary shadow-sm', className)}>
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} className="flex h-[var(--row-h)] items-center gap-3 px-4 [&+&]:hairline-t">
            <Skeleton className="size-6 rounded-[6px]" />
            <Skeleton className="h-3 flex-1" style={{ maxWidth: `${60 - i * 7}%` }} />
            <Skeleton className="h-3 w-12" />
          </div>
        ))}
      </div>
    </Delayed>
  )
}
