import { ChevronDown, TriangleAlert, type LucideIcon } from 'lucide-react'
import * as React from 'react'
import { describeError } from '@/api/errors'
import { cn } from '@/lib/cn'
import { Button } from './button'

/** Empty state (02-ux §3): 48px tertiary icon + headline + subheadline + one primary button. */
export function EmptyState({
  icon: Icon, title, description, action, className, children,
}: {
  icon?: LucideIcon
  title: React.ReactNode
  description?: React.ReactNode
  action?: React.ReactNode
  className?: string
  children?: React.ReactNode
}) {
  return (
    <div className={cn('mx-auto flex max-w-sm flex-col items-center px-6 py-12 text-center', className)}>
      {Icon ? <Icon className="mb-3 size-12 text-tertiary-label" strokeWidth={1.5} aria-hidden /> : null}
      <h2 className="text-title3 text-label">{title}</h2>
      {description ? <p className="mt-1 text-subheadline text-secondary-label">{description}</p> : null}
      {action ? <div className="mt-5">{action}</div> : null}
      {children}
    </div>
  )
}

/**
 * Error state: orange triangle, human message (describeError), [重试], expandable 技术详情.
 * Pass `title` to override the headline (e.g. "字体列表加载失败"); the cause then becomes the text.
 */
export function ErrorState({
  title, error, onRetry, className, actions,
}: {
  title?: React.ReactNode
  error?: unknown
  onRetry?: () => void
  className?: string
  /** Extra buttons next to 重试 */
  actions?: React.ReactNode
}) {
  const [open, setOpen] = React.useState(false)
  const d = error !== undefined && error !== null ? describeError(error) : null
  const heading = title ?? d?.title ?? '加载失败'
  const message = d ? (title ? [d.title, d.hint].filter(Boolean).join('。') : d.hint) : undefined
  const detail = d?.technical || (error && typeof error === 'object' ? safeJson(error) : null)
  return (
    <div className={cn('mx-auto flex max-w-sm flex-col items-center px-6 py-12 text-center', className)}>
      <TriangleAlert className="mb-3 size-12 text-orange" strokeWidth={1.5} aria-hidden />
      <h2 className="text-title3 text-label">{heading}</h2>
      {message ? <p className="mt-1 text-subheadline text-secondary-label">{message}</p> : null}
      {onRetry || actions ? (
        <div className="mt-5 flex flex-wrap justify-center gap-2">
          {onRetry ? (
            <Button variant="filled" onClick={onRetry}>
              重试
            </Button>
          ) : null}
          {actions}
        </div>
      ) : null}
      {detail ? (
        <div className="mt-3 w-full">
          <button type="button" className="inline-flex min-h-8 items-center gap-1 text-footnote text-secondary-label hover:text-label" onClick={() => setOpen(!open)} aria-expanded={open}>
            技术详情 <ChevronDown className={cn('size-3 transition-transform', open && 'rotate-180')} />
          </button>
          {open ? <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-md bg-quaternary-fill p-2 text-left font-mono text-caption text-secondary-label">{detail}</pre> : null}
        </div>
      ) : null}
    </div>
  )
}

function safeJson(e: object): string | null {
  const o: Record<string, unknown> = {}
  for (const k of ['name', 'status', 'code', 'message', 'detail']) {
    const v = (e as Record<string, unknown>)[k]
    if (v !== undefined) o[k] = v
  }
  try {
    return Object.keys(o).length ? JSON.stringify(o, null, 2) : null
  } catch {
    return null
  }
}
