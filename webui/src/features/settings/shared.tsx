import { Check, CircleSlash, TriangleAlert } from 'lucide-react'
import * as React from 'react'
import { describeErrorText } from '@/api/errors'
import { ApiError } from '@/api/client'
import { EmptyState, ErrorState, FormRow, NumberField, Spinner, Switch } from '@/components/ui'
import { cn } from '@/lib/cn'

export type SaveStatus = 'idle' | 'saving' | 'saved' | 'error'

/** "保存中… / ✓ 已保存 / 保存失败" inline indicator (02-ux §3.10: 即时保存，字段旁短暂 check). */
export function SaveIndicator({ status, error, className, onUndo }: { status: SaveStatus; error?: string | null; className?: string; onUndo?: () => void }) {
  return (
    <span role="status" aria-live="polite" className={cn('inline-flex h-5 items-center gap-1 text-footnote', className)}>
      {status === 'saving' ? (
        <>
          <Spinner size={12} />
          <span className="text-secondary-label">保存中…</span>
        </>
      ) : status === 'saved' ? (
        <span className="inline-flex items-center gap-1 text-on-tint-green animate-fade-in">
          <Check className="size-3.5" strokeWidth={2.75} />
          已保存
          {onUndo ? (
            <>
              <span className="text-secondary-label" aria-hidden>·</span>
              <button type="button" onClick={onUndo} className="focus-ring rounded-xs px-0.5 text-accent hover:underline pointer-coarse:min-h-11">
                撤销
              </button>
            </>
          ) : null}
        </span>
      ) : status === 'error' ? (
        <span className="inline-flex items-center gap-1 text-red" title={error ?? undefined}>
          <TriangleAlert className="size-3.5" />
          保存失败
        </span>
      ) : null}
    </span>
  )
}

/** Debounced save helper: call `run(promiseFactory)`; status flips saving → saved (2 s) → idle. */
export function useSaveStatus() {
  const [status, setStatus] = React.useState<SaveStatus>('idle')
  const [error, setError] = React.useState<string | null>(null)
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const run = React.useCallback(async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    if (timer.current) clearTimeout(timer.current)
    setStatus('saving')
    try {
      const r = await fn()
      setStatus('saved')
      setError(null)
      timer.current = setTimeout(() => setStatus('idle'), 6000)
      return r
    } catch (e) {
      setStatus('error')
      setError(describeErrorText(e))
      throw e
    }
  }, [])
  React.useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])
  return { status, error, run }
}

export function isUnavailable(e: unknown) {
  return e instanceof ApiError && (e.status === 404 || e.status === 501)
}

/** Query error: 404/501 → "尚不可用", otherwise ErrorState with retry. */
export function QueryError({ error, onRetry, what = '内容' }: { error: unknown; onRetry?: () => void; what?: string }) {
  if (isUnavailable(error))
    return <EmptyState icon={CircleSlash} title="尚不可用" description={`服务器暂不支持${what}，请更新后端后再试。`} />
  return <ErrorState error={error} onRetry={onRetry} />
}

/** Section heading inside the right-hand form column. */
export function SectionIntro({ title, description, trailing }: { title?: React.ReactNode; description?: React.ReactNode; trailing?: React.ReactNode }) {
  if (!title && !description && !trailing) return null
  return (
    <div className="mb-1 flex items-end gap-3 px-1">
      <div className="min-w-0 flex-1">
        {title ? <h2 className="text-title2 text-label">{title}</h2> : null}
        {description ? <p className="mt-0.5 text-subheadline text-secondary-label">{description}</p> : null}
      </div>
      {trailing}
    </div>
  )
}

export function SwitchRow({
  label, help, checked, onChange, disabled,
}: { label: React.ReactNode; help?: React.ReactNode; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  const id = React.useId()
  return (
    <FormRow label={label} htmlFor={id} help={help}>
      <Switch id={id} checked={checked} onCheckedChange={onChange} disabled={disabled} />
    </FormRow>
  )
}

/**
 * NumberField reserves ~0.62em per unit character, which is too little for "mm" and CJK units
 * (the number then touches the unit). Leading no-break spaces widen the reserved area without
 * showing (the unit is right-aligned).
 */
/** Foundation NumberField drops its unit padding under pointer:coarse (px-3 wins over pr-[…]); restore it. */
export const UNIT_FIX = ''

/** Kept for callers; NumberField now measures CJK units itself. */
export function padUnit(unit?: string) {
  return unit
}

export function NumberRow({
  label, help, value, onChange, unit, min, max, step = 1, precision, disabled, width = 'w-40',
}: {
  label: React.ReactNode
  help?: React.ReactNode
  value: number | null | undefined
  onChange: (v: number) => void
  unit?: string
  min?: number
  max?: number
  step?: number
  precision?: number
  disabled?: boolean
  width?: string
}) {
  const id = React.useId()
  return (
    <FormRow label={label} htmlFor={id} help={help}>
      <NumberField
        id={id}
        className={cn(width, 'pointer-coarse:w-52', unit && UNIT_FIX)}
        value={value ?? null}
        onChange={onChange}
        unit={padUnit(unit)}
        min={min}
        max={max}
        step={step}
        precision={precision}
        disabled={disabled}
      />
    </FormRow>
  )
}
