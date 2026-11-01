import { cva, type VariantProps } from 'class-variance-authority'
import * as React from 'react'
import { cn } from '@/lib/cn'
import { Spinner } from './spinner'
import { Tooltip } from './tooltip'

export const iconButtonVariants = cva(
  [
    'press focus-ring relative inline-flex shrink-0 select-none items-center justify-center rounded-md',
    'transition-[background-color,color] duration-[var(--dur-fast)]',
    'disabled:pointer-events-none disabled:opacity-35 [&_svg]:pointer-events-none',
  ],
  {
    variants: {
      variant: {
        ghost: 'text-secondary-label hover:bg-quaternary-fill hover:text-label active:bg-tertiary-fill data-[active=true]:text-accent data-[state=open]:bg-tertiary-fill',
        gray: 'bg-fill text-label hover:bg-secondary-fill',
        tinted: 'bg-accent/15 text-accent hover:bg-accent/20',
        filled: 'bg-accent text-white hover:brightness-110',
        destructive: 'bg-red text-white hover:brightness-110',
      },
      size: {
        sm: 'size-6 [&_svg]:size-3.5 pointer-coarse:size-9 pointer-coarse:[&_svg]:size-[18px]',
        md: 'size-7 [&_svg]:size-[18px] pointer-coarse:size-11 pointer-coarse:[&_svg]:size-[22px]',
        lg: 'size-9 [&_svg]:size-5 pointer-coarse:size-11 pointer-coarse:[&_svg]:size-6',
        hit: 'size-11 [&_svg]:size-[22px]',
      },
    },
    defaultVariants: { variant: 'ghost', size: 'md' },
  },
)

export interface IconButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof iconButtonVariants> {
  /** Required accessible label (also the tooltip). */
  label: string
  /** Shortcut shown in the tooltip, e.g. "mod+alt+s". */
  shortcut?: string
  tooltipSide?: 'top' | 'bottom' | 'left' | 'right'
  noTooltip?: boolean
  loading?: boolean
  active?: boolean
}

/** Icon-only button with a mandatory Chinese aria-label + tooltip (02-ux §5.3). */
export const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, shortcut, tooltipSide, noTooltip, className, variant, size, children, loading, active, type, ...props },
  ref,
) {
  const btn = (
    <button
      ref={ref}
      type={type ?? 'button'}
      aria-label={label}
      data-active={active || undefined}
      aria-pressed={active === undefined ? undefined : active}
      className={cn(iconButtonVariants({ variant, size }), className)}
      {...props}
    >
      {loading ? <Spinner size={16} /> : children}
    </button>
  )
  return (
    <Tooltip content={noTooltip ? null : label} shortcut={shortcut} side={tooltipSide}>
      {btn}
    </Tooltip>
  )
})
