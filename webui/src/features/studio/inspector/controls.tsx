/** Compact inspector building blocks (300px column; 44px rows on touch). */
import * as React from 'react'
import { Label, NumberField, Segmented, Slider, Switch, type SegmentOption } from '@/components/ui'
import { cn } from '@/lib/cn'

export function Section({ title, children, actions, className }: { title?: React.ReactNode; children: React.ReactNode; actions?: React.ReactNode; className?: string }) {
  return (
    <section className={cn('px-3 py-3 [&+&]:hairline-t', className)}>
      {title ? (
        <div className="mb-2 flex items-center justify-between gap-2 px-1">
          <h3 className="text-footnote font-semibold text-secondary-label">{title}</h3>
          {actions}
        </div>
      ) : null}
      <div className="flex flex-col gap-1.5">{children}</div>
    </section>
  )
}

export function Row({ label, children, htmlFor, className, hint }: { label: React.ReactNode; children: React.ReactNode; htmlFor?: string; className?: string; hint?: React.ReactNode }) {
  return (
    <div className={cn('flex min-h-7 items-center gap-2 px-1 pointer-coarse:min-h-11', className)}>
      <Label htmlFor={htmlFor} className="w-[72px] shrink-0 text-footnote text-secondary-label">
        {label}
        {hint ? <span className="block text-caption text-tertiary-label">{hint}</span> : null}
      </Label>
      <div className="flex min-w-0 flex-1 items-center justify-end gap-1.5">{children}</div>
    </div>
  )
}

export function Num({
  label, value, onChange, unit, step = 0.1, min, max, precision, id, hint,
}: {
  label: React.ReactNode
  value: number | null | undefined
  onChange: (v: number) => void
  unit?: string
  step?: number
  min?: number
  max?: number
  precision?: number
  id?: string
  hint?: React.ReactNode
}) {
  const auto = React.useId()
  return (
    <Row label={label} htmlFor={id ?? auto} hint={hint}>
      <NumberField id={id ?? auto} value={value ?? null} onChange={onChange} unit={unit} step={step} min={min} max={max} precision={precision} className="w-full" />
    </Row>
  )
}

/** Two numbers side by side (X/Y, W/H). */
export function Pair({
  a, b, onA, onB, la, lb, unit = 'mm', step = 0.1, min,
}: { a: number; b: number; onA: (v: number) => void; onB: (v: number) => void; la: string; lb: string; unit?: string; step?: number; min?: number }) {
  return (
    <div className="grid grid-cols-2 gap-1.5 px-1">
      <label className="flex min-w-0 items-center gap-1">
        <span className="w-4 shrink-0 text-center text-footnote text-secondary-label">{la}</span>
        <NumberField value={a} onChange={onA} unit={unit} step={step} min={min} stepper={false} className="min-w-0 flex-1" aria-label={la} />
      </label>
      <label className="flex min-w-0 items-center gap-1">
        <span className="w-4 shrink-0 text-center text-footnote text-secondary-label">{lb}</span>
        <NumberField value={b} onChange={onB} unit={unit} step={step} min={min} stepper={false} className="min-w-0 flex-1" aria-label={lb} />
      </label>
    </div>
  )
}

export function SliderRow({
  label, value, onChange, min, max, step, unit, precision,
}: { label: React.ReactNode; value: number; onChange: (v: number) => void; min: number; max: number; step: number; unit?: string; precision?: number }) {
  return (
    <Row label={label}>
      <Slider value={[value]} min={min} max={max} step={step} onValueChange={([x]) => onChange(x)} className="min-w-0 flex-1" aria-label={typeof label === 'string' ? label : undefined} />
      <NumberField value={value} onChange={onChange} min={min} max={max} step={step} unit={unit} precision={precision} stepper={false} className="w-[68px] shrink-0" />
    </Row>
  )
}

/** Dual-thumb range (jitter min–max) with numeric ends. */
export function RangeRow({
  label, value, onChange, min, max, step, unit,
}: { label: React.ReactNode; value: number[]; onChange: (v: [number, number]) => void; min: number; max: number; step: number; unit?: string }) {
  const lo = value?.[0] ?? min
  const hi = value?.[1] ?? max
  return (
    <div className="flex flex-col gap-1 px-1 py-0.5">
      <div className="flex items-center justify-between">
        <span className="text-footnote text-secondary-label">{label}</span>
        <span className="text-caption tabular-nums text-tertiary-label">
          {lo}
          {unit} – {hi}
          {unit}
        </span>
      </div>
      <div className="flex items-center gap-1.5">
        <NumberField value={lo} onChange={(x) => onChange([Math.min(x, hi), hi])} min={min} max={max} step={step} stepper={false} className="w-[58px] shrink-0" aria-label={`${label} 最小`} />
        <Slider value={[lo, hi]} min={min} max={max} step={step} onValueChange={([a, b]) => onChange([a, b])} className="min-w-0 flex-1" aria-label={typeof label === 'string' ? label : undefined} />
        <NumberField value={hi} onChange={(x) => onChange([lo, Math.max(x, lo)])} min={min} max={max} step={step} stepper={false} className="w-[58px] shrink-0" aria-label={`${label} 最大`} />
      </div>
    </div>
  )
}

export function SwitchRow({ label, checked, onChange, hint }: { label: React.ReactNode; checked: boolean; onChange: (v: boolean) => void; hint?: React.ReactNode }) {
  const id = React.useId()
  return (
    <Row label={label} htmlFor={id} hint={hint}>
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
    </Row>
  )
}

export function SegRow<T extends string>({ label, value, onChange, options }: { label: React.ReactNode; value: T; onChange: (v: T) => void; options: SegmentOption<T>[] }) {
  return (
    <Row label={label}>
      <Segmented value={value} onValueChange={onChange} options={options} size="sm" block aria-label={typeof label === 'string' ? label : undefined} />
    </Row>
  )
}

export function Note({ tone = 'gray', icon, children }: { tone?: 'gray' | 'orange' | 'red' | 'blue'; icon?: React.ReactNode; children: React.ReactNode }) {
  const cls = {
    gray: 'bg-fill/60 text-secondary-label',
    orange: 'bg-orange/15 text-on-tint-orange',
    red: 'bg-red/15 text-on-tint-red',
    blue: 'bg-blue/15 text-on-tint-blue',
  }[tone]
  return (
    <div className={cn('mx-1 flex items-start gap-1.5 rounded-md px-2 py-1.5 text-footnote [&_svg]:mt-[1px] [&_svg]:size-3.5 [&_svg]:shrink-0', cls)} role={tone === 'red' || tone === 'orange' ? 'status' : undefined}>
      {icon}
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}
