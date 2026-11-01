import { Check, ChevronsUpDown, Search, X } from 'lucide-react'
import * as React from 'react'
import { cn } from '@/lib/cn'
import { Input, type InputProps } from './input'
import { Popover, PopoverContent, PopoverTrigger } from './popover'

/** Search field with magnifier and clear button (HIG search field). */
export const SearchField = React.forwardRef<
  HTMLInputElement,
  Omit<InputProps, 'leading' | 'trailing' | 'onChange' | 'value'> & { value: string; onValueChange: (v: string) => void }
>(function SearchField({ value, onValueChange, placeholder = '搜索', className, ...props }, ref) {
  return (
    <Input
      ref={ref}
      type="search"
      role="searchbox"
      value={value}
      placeholder={placeholder}
      onChange={(e) => onValueChange(e.currentTarget.value)}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && value) {
          e.stopPropagation()
          onValueChange('')
        }
        props.onKeyDown?.(e)
      }}
      leading={<Search />}
      trailing={
        value ? (
          <button
            type="button"
            aria-label="清除"
            onClick={() => onValueChange('')}
            className="flex size-5 items-center justify-center rounded-full text-tertiary-label hover:text-secondary-label pointer-coarse:size-8"
          >
            <X className="size-3.5 rounded-full bg-tertiary-label p-0.5 text-bg-elevated" strokeWidth={3} />
          </button>
        ) : null
      }
      className={cn('[&_input]:bg-tertiary-fill [&_input]:shadow-none [&_input::-webkit-search-cancel-button]:hidden', className)}
      {...props}
    />
  )
})

export interface ComboboxOption {
  value: string
  label: string
  description?: string
  /** Extra search terms (pinyin, aliases…). */
  keywords?: string[]
  disabled?: boolean
  render?: React.ReactNode
}

/**
 * Searchable single-select (fonts, papers, profiles…).
 *   <Combobox value={fontId} onValueChange={setFontId} options={fonts.map(f => ({value:f.id,label:f.display_name}))} />
 */
export function Combobox({
  value, onValueChange, options, placeholder = '请选择', searchPlaceholder = '搜索', emptyText = '无匹配项',
  className, contentClassName, disabled, id, 'aria-label': ariaLabel, footer,
}: {
  value: string | null | undefined
  onValueChange: (v: string) => void
  options: ComboboxOption[]
  placeholder?: string
  searchPlaceholder?: string
  emptyText?: string
  className?: string
  contentClassName?: string
  disabled?: boolean
  id?: string
  'aria-label'?: string
  /** Extra content under the list (e.g. "导入字体…"). */
  footer?: React.ReactNode
}) {
  const [open, setOpen] = React.useState(false)
  const [q, setQ] = React.useState('')
  const [active, setActive] = React.useState(0)
  const listId = React.useId()
  const listRef = React.useRef<HTMLDivElement>(null)
  const selected = options.find((o) => o.value === value)
  const filtered = React.useMemo(() => {
    const t = q.trim().toLowerCase()
    if (!t) return options
    return options.filter((o) => [o.label, o.value, o.description ?? '', ...(o.keywords ?? [])].some((s) => s.toLowerCase().includes(t)))
  }, [q, options])

  React.useEffect(() => {
    if (open) {
      setQ('')
      setActive(Math.max(0, options.findIndex((o) => o.value === value)))
    }
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps
  React.useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const choose = (o: ComboboxOption | undefined) => {
    if (!o || o.disabled) return
    onValueChange(o.value)
    setOpen(false)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild disabled={disabled}>
        <button
          id={id}
          type="button"
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-label={ariaLabel}
          className={cn(
            'focus-ring press inline-flex h-7 min-w-0 items-center justify-between gap-1.5 rounded-sm bg-bg-elevated pl-2 pr-1 text-body shadow-sm pointer-coarse:h-11 pointer-coarse:pl-3',
            'disabled:opacity-40',
            className,
          )}
        >
          <span className={cn('truncate', !selected && 'text-tertiary-label')}>{selected?.label ?? placeholder}</span>
          <span className="flex h-4 w-4 items-center justify-center rounded-[4px] bg-accent text-white pointer-coarse:bg-transparent pointer-coarse:text-tertiary-label">
            <ChevronsUpDown className="size-3" strokeWidth={2.5} />
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className={cn('w-[max(var(--radix-popover-trigger-width),260px)] p-1.5', contentClassName)}>
        <SearchField
          autoFocus
          value={q}
          onValueChange={(v) => {
            setQ(v)
            setActive(0)
          }}
          placeholder={searchPlaceholder}
          aria-controls={listId}
          aria-activedescendant={filtered[active] ? `${listId}-${active}` : undefined}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setActive((a) => Math.min(filtered.length - 1, a + 1))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setActive((a) => Math.max(0, a - 1))
            } else if (e.key === 'Enter') {
              e.preventDefault()
              choose(filtered[active])
            }
          }}
        />
        <div ref={listRef} id={listId} role="listbox" className="mt-1 max-h-72 overflow-y-auto overscroll-contain">
          {filtered.length === 0 ? <div className="px-2 py-6 text-center text-footnote text-secondary-label">{emptyText}</div> : null}
          {filtered.map((o, i) => (
            <div
              key={o.value}
              id={`${listId}-${i}`}
              data-index={i}
              role="option"
              aria-selected={o.value === value}
              aria-disabled={o.disabled || undefined}
              onMouseMove={() => setActive(i)}
              onClick={() => choose(o)}
              className={cn(
                'flex min-h-6 cursor-default items-center gap-2 rounded-[5px] py-1 pl-6 pr-2 text-body pointer-coarse:min-h-11 pointer-coarse:pl-8',
                i === active && 'bg-accent text-white',
                o.disabled && 'opacity-40',
                'relative',
              )}
            >
              {o.value === value ? <Check className="absolute left-1.5 size-3.5 pointer-coarse:left-2.5" strokeWidth={2.5} /> : null}
              <span className="min-w-0 flex-1">
                {o.render ?? <span className="block truncate">{o.label}</span>}
                {o.description ? <span className={cn('block truncate text-footnote', i === active ? 'text-white/80' : 'text-secondary-label')}>{o.description}</span> : null}
              </span>
            </div>
          ))}
        </div>
        {footer ? <div className="mt-1 border-t border-separator pt-1">{footer}</div> : null}
      </PopoverContent>
    </Popover>
  )
}
