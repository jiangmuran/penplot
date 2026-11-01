import * as TooltipPrimitive from '@radix-ui/react-tooltip'
import * as React from 'react'
import { cn } from '@/lib/cn'
import { Kbd } from './kbd'

export const TooltipProvider = ({ children }: { children: React.ReactNode }) => (
  <TooltipPrimitive.Provider delayDuration={500} skipDelayDuration={300}>
    {children}
  </TooltipPrimitive.Provider>
)

export const TooltipRoot = TooltipPrimitive.Root
export const TooltipTrigger = TooltipPrimitive.Trigger

export const TooltipContent = React.forwardRef<
  React.ComponentRef<typeof TooltipPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(function TooltipContent({ className, sideOffset = 6, ...props }, ref) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        ref={ref}
        sideOffset={sideOffset}
        className={cn(
          'z-[60] flex max-w-72 items-center gap-2 rounded-sm bg-bg-elevated px-2 py-1 text-footnote text-label shadow-md',
          'data-[state=closed]:animate-fade-out data-[state=delayed-open]:animate-pop-in data-[state=instant-open]:animate-fade-in',
          className,
        )}
        {...props}
      />
    </TooltipPrimitive.Portal>
  )
})

/**
 * Simple tooltip wrapper: <Tooltip content="撤销" shortcut="mod+z"><IconButton …/></Tooltip>
 * Tooltips are hidden on touch devices by Radix (no hover).
 */
export function Tooltip({
  content,
  shortcut,
  side,
  children,
  disabled,
}: {
  content: React.ReactNode
  shortcut?: string
  side?: 'top' | 'bottom' | 'left' | 'right'
  children: React.ReactElement
  disabled?: boolean
}) {
  if (disabled || !content) return children
  return (
    <TooltipRoot>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side}>
        <span>{content}</span>
        {shortcut ? <Kbd keys={shortcut} className="-mr-0.5" /> : null}
      </TooltipContent>
    </TooltipRoot>
  )
}
