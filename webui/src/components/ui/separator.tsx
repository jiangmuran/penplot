import * as SeparatorPrimitive from '@radix-ui/react-separator'
import * as React from 'react'
import { cn } from '@/lib/cn'

/** 0.5px hairline separator. */
export const Separator = React.forwardRef<
  React.ComponentRef<typeof SeparatorPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof SeparatorPrimitive.Root> & { inset?: boolean }
>(function Separator({ className, orientation = 'horizontal', decorative = true, inset, ...props }, ref) {
  return (
    <SeparatorPrimitive.Root
      ref={ref}
      decorative={decorative}
      orientation={orientation}
      className={cn(
        'shrink-0 bg-separator',
        orientation === 'horizontal' ? 'h-px w-full scale-y-50' : 'h-full w-px scale-x-50',
        inset && orientation === 'horizontal' && 'ml-4 w-auto',
        className,
      )}
      {...props}
    />
  )
})
