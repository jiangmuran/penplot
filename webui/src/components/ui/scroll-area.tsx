import * as SA from '@radix-ui/react-scroll-area'
import * as React from 'react'
import { cn } from '@/lib/cn'

/** Overlay scrollbars (macOS style). The viewport gets `viewportRef` / `viewportClassName`. */
export const ScrollArea = React.forwardRef<
  React.ComponentRef<typeof SA.Root>,
  React.ComponentPropsWithoutRef<typeof SA.Root> & {
    viewportRef?: React.Ref<HTMLDivElement>
    viewportClassName?: string
    orientation?: 'vertical' | 'horizontal' | 'both'
  }
>(function ScrollArea({ className, children, viewportRef, viewportClassName, orientation = 'vertical', type = 'scroll', ...props }, ref) {
  return (
    <SA.Root ref={ref} type={type} className={cn('relative overflow-hidden', className)} {...props}>
      <SA.Viewport ref={viewportRef} className={cn('size-full rounded-[inherit] [&>div]:!block', viewportClassName)}>
        {children}
      </SA.Viewport>
      {orientation !== 'horizontal' ? <ScrollBar orientation="vertical" /> : null}
      {orientation !== 'vertical' ? <ScrollBar orientation="horizontal" /> : null}
      <SA.Corner />
    </SA.Root>
  )
})

function ScrollBar({ orientation }: { orientation: 'vertical' | 'horizontal' }) {
  return (
    <SA.Scrollbar
      orientation={orientation}
      className={cn(
        'z-10 flex touch-none select-none p-0.5 transition-opacity duration-[var(--dur-base)] data-[state=hidden]:opacity-0',
        orientation === 'vertical' ? 'h-full w-2.5' : 'h-2.5 flex-col',
      )}
    >
      <SA.Thumb className="relative flex-1 rounded-full bg-tertiary-label hover:bg-secondary-label" />
    </SA.Scrollbar>
  )
}
