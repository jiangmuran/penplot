import { Minus, Plus } from 'lucide-react'
import * as React from 'react'
import { cn } from '@/lib/cn'
import { inputBase } from './input'

export interface NumberFieldProps {
  value: number | null
  onChange: (v: number) => void
  min?: number
  max?: number
  step?: number
  /** Decimal places shown (default inferred from step). */
  precision?: number
  /** Unit suffix: "mm", "°", "%", "mm/min". */
  unit?: string
  /** Show −/+ stepper buttons (default true). */
  stepper?: boolean
  disabled?: boolean
  invalid?: boolean
  id?: string
  className?: string
  'aria-label'?: string
  'aria-describedby'?: string
  placeholder?: string
}

function decimals(step: number) {
  const s = String(step)
  return s.includes('.') ? s.split('.')[1].length : 0
}

/**
 * Numeric field with unit and stepper. Commits on Enter/blur; ↑/↓ = step, Shift ×10, Alt ×0.1.
 * Accepts typed values with comma decimal separators.
 */
export function NumberField({
  value, onChange, min = -Infinity, max = Infinity, step = 1, precision, unit, stepper = true, disabled, invalid,
  id, className, placeholder, ...aria
}: NumberFieldProps) {
  const prec = precision ?? decimals(step)
  const fmt = React.useCallback((v: number | null) => (v == null || !Number.isFinite(v) ? '' : String(Number(v.toFixed(prec)))), [prec])
  const [text, setText] = React.useState(fmt(value))
  const [focused, setFocused] = React.useState(false)
  React.useEffect(() => {
    if (!focused) setText(fmt(value))
  }, [value, focused, fmt])

  const clamp = (v: number) => Math.min(max, Math.max(min, v))
  const round = (v: number) => Number(v.toFixed(Math.max(prec, 4)))
  const commit = (raw: string) => {
    const n = Number(raw.replace(',', '.').trim())
    if (raw.trim() === '' || !Number.isFinite(n)) {
      setText(fmt(value))
      return
    }
    const v = round(clamp(n))
    setText(fmt(v))
    if (v !== value) onChange(v)
  }
  const bump = (dir: 1 | -1, mult = 1) => {
    const base = value ?? (Number.isFinite(min) ? min : 0)
    const v = round(clamp(base + dir * step * mult))
    setText(fmt(v))
    onChange(v)
  }

  return (
    <div className={cn('inline-flex items-stretch gap-1', className)}>
      <div className="relative flex min-w-0 flex-1 items-center">
        <input
          id={id}
          inputMode="decimal"
          autoComplete="off"
          spellCheck={false}
          disabled={disabled}
          placeholder={placeholder}
          aria-invalid={invalid || undefined}
          aria-valuemin={Number.isFinite(min) ? min : undefined}
          aria-valuemax={Number.isFinite(max) ? max : undefined}
          aria-valuenow={value ?? undefined}
          role="spinbutton"
          {...aria}
          value={text}
          onFocus={(e) => {
            setFocused(true)
            e.currentTarget.select()
          }}
          onBlur={(e) => {
            setFocused(false)
            commit(e.currentTarget.value)
          }}
          onChange={(e) => setText(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit(e.currentTarget.value)
            else if (e.key === 'Escape') setText(fmt(value))
            else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
              e.preventDefault()
              bump(e.key === 'ArrowUp' ? 1 : -1, e.shiftKey ? 10 : e.altKey ? 0.1 : 1)
            }
          }}
          className={cn(
            inputBase,
            'h-7 px-2 text-right tabular-nums pointer-coarse:h-11 pointer-coarse:px-3',
            unit && 'pr-[calc(var(--unit-w)+12px)] pointer-coarse:pr-[calc(var(--unit-w)+18px)]',
          )}
          style={{ ['--unit-w' as string]: `${unitWidthPx(unit)}px` }}
        />
        {unit ? (
          <span className="pointer-events-none absolute right-2 text-footnote text-secondary-label pointer-coarse:right-3">{unit}</span>
        ) : null}
      </div>
      {stepper ? (
        <div className="flex shrink-0 overflow-hidden rounded-sm bg-fill pointer-coarse:rounded-md">
          <button
            type="button"
            tabIndex={-1}
            aria-label="减少"
            disabled={disabled || (value != null && value <= min)}
            onClick={() => bump(-1)}
            className="press flex w-6 items-center justify-center text-label hover:bg-secondary-fill disabled:opacity-35 pointer-coarse:w-11"
          >
            <Minus className="size-3 pointer-coarse:size-4" strokeWidth={2.5} />
          </button>
          <span className="my-1.5 w-px bg-separator" aria-hidden />
          <button
            type="button"
            tabIndex={-1}
            aria-label="增加"
            disabled={disabled || (value != null && value >= max)}
            onClick={() => bump(1)}
            className="press flex w-6 items-center justify-center text-label hover:bg-secondary-fill disabled:opacity-35 pointer-coarse:w-11"
          >
            <Plus className="size-3 pointer-coarse:size-4" strokeWidth={2.5} />
          </button>
        </div>
      ) : null}
    </div>
  )
}

/** Approximate rendered width of the unit label (footnote size; CJK glyphs are full-width). */
function unitWidthPx(unit?: string) {
  if (!unit) return 0
  let w = 0
  for (const ch of unit) w += /[\u3000-\u9fff\uff00-\uffef]/.test(ch) ? 1 : ch === '\u00a0' || ch === ' ' ? 0.3 : 0.6
  return Math.ceil(w * 15) + 4
}
