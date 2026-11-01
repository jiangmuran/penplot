import * as ToggleGroup from '@radix-ui/react-toggle-group'
import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/cn'

export interface SegmentOption<T extends string> {
  value: T
  label?: React.ReactNode
  icon?: LucideIcon
  /** aria-label for icon-only segments */
  ariaLabel?: string
  disabled?: boolean
}

/**
 * Segmented control (single selection, never empty).
 *   <Segmented value={mode} onValueChange={setMode} options={[{value:'free',label:'自由'},{value:'letter',label:'信笺'}]} />
 */
export function Segmented<T extends string>({
  value, onValueChange, options, className, size = 'md', block, 'aria-label': ariaLabel,
}: {
  value: T
  onValueChange: (v: T) => void
  options: SegmentOption<T>[]
  className?: string
  size?: 'sm' | 'md'
  block?: boolean
  'aria-label'?: string
}) {
  return (
    <ToggleGroup.Root
      type="single"
      value={value}
      aria-label={ariaLabel}
      onValueChange={(v) => v && onValueChange(v as T)}
      className={cn(
        'inline-flex shrink-0 items-stretch gap-0.5 rounded-md bg-tertiary-fill p-0.5',
        size === 'sm' ? 'h-6' : 'h-7 pointer-coarse:h-9',
        block && 'flex w-full',
        className,
      )}
    >
      {options.map((o) => {
        const Icon = o.icon
        return (
          <ToggleGroup.Item
            key={o.value}
            value={o.value}
            disabled={o.disabled}
            aria-label={o.ariaLabel}
            className={cn(
              'focus-ring relative flex min-w-0 flex-1 items-center justify-center gap-1 whitespace-nowrap rounded-[6px] px-2.5 font-medium',
              size === 'sm' ? 'text-footnote' : 'text-body',
              'text-label transition-[background-color,box-shadow] duration-[var(--dur-fast)]',
              'hover:bg-quaternary-fill data-[state=on]:bg-bg-elevated data-[state=on]:shadow-sm dark:data-[state=on]:bg-gray3',
              'disabled:opacity-40 [&_svg]:size-4',
            )}
          >
            {Icon ? <Icon aria-hidden /> : null}
            {o.label}
          </ToggleGroup.Item>
        )
      })}
    </ToggleGroup.Root>
  )
}
