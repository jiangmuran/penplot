import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'
import * as React from 'react'
import { cn } from '@/lib/cn'
import { Spinner } from './spinner'

/**
 * HIG button. Variants:
 * - `filled`   accent solid — the single primary action per screen
 * - `gray`     neutral fill (default secondary)
 * - `tinted`   accent at 15% with accent text
 * - `plain`    text-only accent (links, toolbar text buttons)
 * - `destructive` red solid; `destructive-plain` red text (alert dialogs); `destructive-tinted`
 * - `bordered` hairline outline
 * Sizes follow pointer density: `md` is 28px with a mouse, 44px on touch.
 */
export const buttonVariants = cva(
  [
    'press focus-ring relative inline-flex select-none items-center justify-center gap-1.5 whitespace-nowrap font-medium',
    'transition-[background-color,color,box-shadow,opacity] duration-[var(--dur-fast)]',
    'disabled:pointer-events-none disabled:opacity-40 aria-disabled:pointer-events-none aria-disabled:opacity-40',
    '[&_svg]:pointer-events-none [&_svg]:shrink-0',
  ],
  {
    variants: {
      variant: {
        filled: 'bg-accent text-white shadow-sm hover:brightness-110 active:brightness-95',
        gray: 'bg-fill text-label hover:bg-secondary-fill active:bg-fill',
        tinted: 'bg-accent/15 text-accent hover:bg-accent/20 active:bg-accent/25',
        plain: 'bg-transparent text-accent hover:bg-quaternary-fill active:bg-tertiary-fill',
        bordered: 'bg-bg-elevated text-label shadow-sm hover:bg-quaternary-fill',
        destructive: 'bg-red text-white shadow-sm hover:brightness-110 active:brightness-95',
        'destructive-tinted': 'bg-red/15 text-red hover:bg-red/20',
        'destructive-plain': 'bg-transparent text-red hover:bg-red/10',
        ghost: 'bg-transparent text-label hover:bg-quaternary-fill active:bg-tertiary-fill',
      },
      size: {
        sm: 'h-6 rounded-sm px-2 text-footnote [&_svg]:size-3.5 pointer-coarse:h-9 pointer-coarse:px-3',
        md: 'h-7 rounded-md px-3 text-body [&_svg]:size-4 pointer-coarse:h-11 pointer-coarse:px-4 pointer-coarse:[&_svg]:size-5',
        lg: 'h-9 rounded-lg px-4 text-body [&_svg]:size-[18px] pointer-coarse:h-[50px] pointer-coarse:rounded-xl pointer-coarse:px-5 pointer-coarse:text-headline',
        xl: 'h-11 rounded-lg px-5 text-headline [&_svg]:size-5 pointer-coarse:h-[50px] pointer-coarse:rounded-xl',
      },
      block: { true: 'w-full' },
    },
    defaultVariants: { variant: 'gray', size: 'md' },
  },
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean
  loading?: boolean
  /** Leading icon element (e.g. <Plus />). */
  icon?: React.ReactNode
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant, size, block, asChild, loading, icon, children, disabled, type, ...props },
  ref,
) {
  const Comp = asChild ? Slot : 'button'
  return (
    <Comp
      ref={ref}
      type={asChild ? undefined : (type ?? 'button')}
      className={cn(buttonVariants({ variant, size, block }), className)}
      disabled={asChild ? undefined : disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {asChild ? (
        children
      ) : (
        <>
          {loading ? <Spinner size={14} /> : icon}
          {children}
        </>
      )}
    </Comp>
  )
})
