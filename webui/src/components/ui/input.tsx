import * as React from 'react'
import { cn } from '@/lib/cn'

export const inputBase = cn(
  'w-full min-w-0 rounded-sm bg-bg-elevated text-body text-label placeholder:text-tertiary-label',
  'shadow-[inset_0_0_0_0.5px_rgb(var(--separator)/var(--separator-a)),0_0.5px_1px_rgb(0_0_0/0.04)]',
  'transition-shadow duration-[var(--dur-fast)] outline-none',
  'focus-visible:outline-none focus:shadow-[inset_0_0_0_1px_rgb(var(--accent)),0_0_0_3px_rgb(var(--accent)/0.3)]',
  'disabled:opacity-50 aria-[invalid=true]:shadow-[inset_0_0_0_1px_rgb(var(--red)),0_0_0_3px_rgb(var(--red)/0.2)]',
)

export interface InputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'size'> {
  /** Leading adornment (icon). */
  leading?: React.ReactNode
  /** Trailing adornment (unit, button). */
  trailing?: React.ReactNode
  invalid?: boolean
  inputSize?: 'md' | 'lg'
}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, leading, trailing, invalid, inputSize = 'md', ...props },
  ref,
) {
  const h = inputSize === 'lg' ? 'h-9 pointer-coarse:h-12 rounded-md' : 'h-7 pointer-coarse:h-11'
  if (!leading && !trailing) {
    return <input ref={ref} aria-invalid={invalid || undefined} className={cn(inputBase, h, 'px-2 pointer-coarse:px-3', className)} {...props} />
  }
  return (
    <div className={cn('relative flex items-center', className)}>
      {leading ? (
        <span className="pointer-events-none absolute left-2 flex items-center text-tertiary-label [&_svg]:size-4 pointer-coarse:left-3">{leading}</span>
      ) : null}
      <input
        ref={ref}
        aria-invalid={invalid || undefined}
        className={cn(inputBase, h, 'px-2 pointer-coarse:px-3', leading && 'pl-7 pointer-coarse:pl-9', trailing && 'pr-8 pointer-coarse:pr-10')}
        {...props}
      />
      {trailing ? <span className="absolute right-1 flex items-center text-secondary-label">{trailing}</span> : null}
    </div>
  )
})

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }>(
  function Textarea({ className, invalid, ...props }, ref) {
    return (
      <textarea
        ref={ref}
        aria-invalid={invalid || undefined}
        className={cn(inputBase, 'min-h-20 resize-y px-2 py-1.5 pointer-coarse:px-3 pointer-coarse:py-2.5', className)}
        {...props}
      />
    )
  },
)
