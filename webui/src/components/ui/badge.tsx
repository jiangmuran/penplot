import { cva, type VariantProps } from 'class-variance-authority'
import type { LucideIcon } from 'lucide-react'
import * as React from 'react'
import { cn } from '@/lib/cn'
import { Spinner } from './spinner'

export const badgeVariants = cva(
  'inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-xs font-medium tabular-nums [&_svg]:size-3',
  {
    variants: {
      tone: {
        gray: 'bg-fill text-secondary-label',
        blue: 'bg-blue/15 text-on-tint-blue',
        green: 'bg-green/15 text-on-tint-green',
        orange: 'bg-orange/15 text-on-tint-orange',
        red: 'bg-red/15 text-on-tint-red',
        accent: 'bg-accent/15 text-accent',
        solid: 'bg-accent text-white',
      },
      size: {
        sm: 'h-4 px-1 text-caption',
        md: 'h-5 px-1.5 text-caption',
      },
      shape: { rounded: '', capsule: 'rounded-full' },
    },
    defaultVariants: { tone: 'gray', size: 'md', shape: 'rounded' },
  },
)

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {
  icon?: LucideIcon
}

/** Small status badge (徽章). Colour + text (+ icon) always together. */
export function Badge({ className, tone, size, shape, icon: Icon, children, ...props }: BadgeProps) {
  return (
    <span className={cn(badgeVariants({ tone, size, shape }), className)} {...props}>
      {Icon ? <Icon aria-hidden /> : null}
      {children}
    </span>
  )
}

export interface StatusPillProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone: 'gray' | 'blue' | 'green' | 'orange' | 'red'
  icon?: LucideIcon
  spin?: boolean
  /** 0–100: renders a small progress ring instead of the icon. */
  progress?: number | null
}

const pillTone = {
  gray: 'bg-fill text-secondary-label',
  blue: 'bg-blue/15 text-on-tint-blue',
  green: 'bg-green/15 text-on-tint-green',
  orange: 'bg-orange/15 text-on-tint-orange',
  red: 'bg-red/15 text-on-tint-red',
}

/** Capsule with status colour at 15%, `on-tint` text (≥4.5:1), icon + text. */
export function StatusPill({ tone, icon: Icon, spin, progress, className, children, ...props }: StatusPillProps) {
  return (
    <span
      className={cn(
        'inline-flex h-6 items-center gap-1.5 whitespace-nowrap rounded-full pl-2 pr-2.5 text-footnote font-medium tabular-nums pointer-coarse:h-8',
        pillTone[tone],
        className,
      )}
      {...props}
    >
      {progress != null ? (
        <MiniRing value={progress} />
      ) : spin ? (
        <Spinner size={13} />
      ) : Icon ? (
        <Icon aria-hidden className="size-[13px] shrink-0" strokeWidth={2.25} />
      ) : null}
      {children}
    </span>
  )
}

function MiniRing({ value }: { value: number }) {
  const r = 5
  const c = 2 * Math.PI * r
  const v = Math.max(0, Math.min(100, value))
  return (
    <svg viewBox="0 0 14 14" className="size-[13px] -rotate-90" aria-hidden>
      <circle cx="7" cy="7" r={r} fill="none" stroke="currentColor" strokeOpacity={0.25} strokeWidth={2.2} />
      <circle cx="7" cy="7" r={r} fill="none" stroke="currentColor" strokeWidth={2.2} strokeDasharray={c} strokeDashoffset={c * (1 - v / 100)} strokeLinecap="round" />
    </svg>
  )
}
