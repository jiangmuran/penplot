import * as SelectPrimitive from '@radix-ui/react-select'
import { Check, ChevronDown, ChevronsUpDown, ChevronUp } from 'lucide-react'
import * as React from 'react'
import { cn } from '@/lib/cn'

export const SelectRoot = SelectPrimitive.Root
export const SelectGroup = SelectPrimitive.Group
export const SelectValue = SelectPrimitive.Value

export const SelectTrigger = React.forwardRef<
  React.ComponentRef<typeof SelectPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Trigger> & { variant?: 'bordered' | 'plain' }
>(function SelectTrigger({ className, children, variant = 'bordered', ...props }, ref) {
  return (
    <SelectPrimitive.Trigger
      ref={ref}
      className={cn(
        'focus-ring press inline-flex h-7 min-w-0 items-center justify-between gap-1.5 rounded-sm pl-2 pr-1 text-body text-label pointer-coarse:h-11 pointer-coarse:pl-3 pointer-coarse:pr-2',
        variant === 'bordered' && 'bg-bg-elevated shadow-sm',
        variant === 'plain' && 'bg-transparent text-secondary-label hover:bg-quaternary-fill',
        'data-[placeholder]:text-tertiary-label disabled:opacity-40 [&>span]:truncate',
        className,
      )}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon asChild>
        {variant === 'bordered' ? (
          <span className="flex h-4 w-4 items-center justify-center rounded-[4px] bg-accent text-white pointer-coarse:bg-transparent pointer-coarse:text-tertiary-label">
            <ChevronsUpDown className="size-3 pointer-coarse:size-4" strokeWidth={2.5} />
          </span>
        ) : (
          <ChevronDown className="size-3.5 opacity-70" />
        )}
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  )
})

export const SelectContent = React.forwardRef<
  React.ComponentRef<typeof SelectPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Content>
>(function SelectContent({ className, children, position = 'popper', ...props }, ref) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        ref={ref}
        position={position}
        sideOffset={4}
        className={cn(
          'mat-thick relative z-50 max-h-[min(var(--radix-select-content-available-height),360px)] min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-lg p-1 shadow-md',
          'data-[state=open]:animate-pop-in data-[state=closed]:animate-pop-out origin-[var(--radix-select-content-transform-origin)]',
          className,
        )}
        {...props}
      >
        <SelectPrimitive.ScrollUpButton className="flex h-5 items-center justify-center text-secondary-label">
          <ChevronUp className="size-3.5" />
        </SelectPrimitive.ScrollUpButton>
        <SelectPrimitive.Viewport>{children}</SelectPrimitive.Viewport>
        <SelectPrimitive.ScrollDownButton className="flex h-5 items-center justify-center text-secondary-label">
          <ChevronDown className="size-3.5" />
        </SelectPrimitive.ScrollDownButton>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  )
})

export const SelectItem = React.forwardRef<
  React.ComponentRef<typeof SelectPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Item>
>(function SelectItem({ className, children, ...props }, ref) {
  return (
    <SelectPrimitive.Item
      ref={ref}
      className={cn(
        'relative flex h-6 cursor-default select-none items-center rounded-[5px] pl-6 pr-2 text-body text-label outline-none pointer-coarse:h-11 pointer-coarse:pl-8',
        'data-[highlighted]:bg-accent data-[highlighted]:text-white data-[disabled]:opacity-40',
        className,
      )}
      {...props}
    >
      <span className="absolute left-1.5 flex size-3.5 items-center justify-center pointer-coarse:left-2.5">
        <SelectPrimitive.ItemIndicator>
          <Check className="size-3.5" strokeWidth={2.5} />
        </SelectPrimitive.ItemIndicator>
      </span>
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
    </SelectPrimitive.Item>
  )
})

export const SelectLabel = ({ className, ...p }: React.ComponentPropsWithoutRef<typeof SelectPrimitive.Label>) => (
  <SelectPrimitive.Label className={cn('px-2 pb-0.5 pt-1.5 text-footnote font-semibold text-secondary-label', className)} {...p} />
)
export const SelectSeparator = ({ className, ...p }: React.ComponentPropsWithoutRef<typeof SelectPrimitive.Separator>) => (
  <SelectPrimitive.Separator className={cn('mx-2 my-1 h-px scale-y-50 bg-separator', className)} {...p} />
)

export interface SelectOption {
  value: string
  label: React.ReactNode
  disabled?: boolean
}

/** Convenience select: <Select value={v} onValueChange={setV} options={[…]} /> */
export function Select({
  value, onValueChange, options, placeholder, className, disabled, id, 'aria-label': ariaLabel, variant,
}: {
  value: string | undefined
  onValueChange: (v: string) => void
  options: SelectOption[]
  placeholder?: string
  className?: string
  disabled?: boolean
  id?: string
  'aria-label'?: string
  variant?: 'bordered' | 'plain'
}) {
  return (
    <SelectRoot value={value} onValueChange={onValueChange} disabled={disabled}>
      <SelectTrigger id={id} aria-label={ariaLabel} className={className} variant={variant}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value} disabled={o.disabled}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </SelectRoot>
  )
}
