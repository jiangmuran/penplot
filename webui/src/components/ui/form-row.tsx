import * as React from 'react'
import { cn } from '@/lib/cn'
import { Label } from './label'

/**
 * Inspector / settings row: label left, control right, optional help & error below (44px rows).
 * Associates the label with the control via `htmlFor` (pass the same `id` to the control) and
 * exposes `helpId`/`errorId` for `aria-describedby`.
 *
 *   <FormRow label="字号" htmlFor="size" help="字形 em 高度"><NumberField id="size" unit="mm" …/></FormRow>
 */
export function FormRow({
  label, htmlFor, help, error, children, className, stacked, controlClassName,
}: {
  label: React.ReactNode
  htmlFor?: string
  help?: React.ReactNode
  error?: React.ReactNode
  children: React.ReactNode
  className?: string
  /** Label above the control (forms, compact). */
  stacked?: boolean
  controlClassName?: string
}) {
  const auto = React.useId()
  const id = htmlFor ?? auto
  const helpId = `${id}-help`
  const errorId = `${id}-error`
  return (
    <div className={cn('px-4 py-1.5', className)}>
      <div className={cn('flex min-h-[calc(var(--row-h)-12px)] gap-3', stacked ? 'flex-col gap-1.5' : 'items-center justify-between')}>
        <Label htmlFor={id} className={cn('shrink-0', stacked ? 'text-footnote font-medium text-secondary-label' : 'text-body')}>
          {label}
        </Label>
        <div
          className={cn('flex min-w-0 items-center justify-end gap-2', stacked ? 'w-full' : 'flex-1', controlClassName)}
          data-describedby={[help ? helpId : null, error ? errorId : null].filter(Boolean).join(' ') || undefined}
        >
          {children}
        </div>
      </div>
      {error ? (
        <p id={errorId} role="alert" className="mt-1 text-footnote text-red">
          {error}
        </p>
      ) : help ? (
        <p id={helpId} className="mt-1 text-footnote text-secondary-label">
          {help}
        </p>
      ) : null}
    </div>
  )
}

/** Vertical field for full-width forms (login, dialogs). */
export function FormField({
  label, htmlFor, help, error, children, className,
}: {
  label?: React.ReactNode
  htmlFor?: string
  help?: React.ReactNode
  error?: React.ReactNode
  children: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      {label ? (
        <Label htmlFor={htmlFor} className="text-footnote font-medium text-secondary-label">
          {label}
        </Label>
      ) : null}
      {children}
      {error ? (
        <p id={htmlFor ? `${htmlFor}-error` : undefined} role="alert" className="text-footnote text-red">
          {error}
        </p>
      ) : help ? (
        <p id={htmlFor ? `${htmlFor}-help` : undefined} className="text-footnote text-secondary-label">
          {help}
        </p>
      ) : null}
    </div>
  )
}
