import * as TabsPrimitive from '@radix-ui/react-tabs'
import * as React from 'react'
import { cn } from '@/lib/cn'

export const Tabs = TabsPrimitive.Root

/**
 * Tab list. `variant="segmented"` (default) looks like a HIG segmented control (toolbar / inspector
 * groups); `variant="underline"` is a lighter text tab bar for long lists.
 */
export const TabsList = React.forwardRef<
  React.ComponentRef<typeof TabsPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List> & { variant?: 'segmented' | 'underline' }
>(function TabsList({ className, variant = 'segmented', ...props }, ref) {
  return (
    <TabsPrimitive.List
      ref={ref}
      data-variant={variant}
      className={cn(
        'group/tabs inline-flex shrink-0 items-stretch',
        variant === 'segmented' && 'h-7 gap-0.5 rounded-md bg-tertiary-fill p-0.5 pointer-coarse:h-9',
        variant === 'underline' && 'h-9 gap-4 hairline-b',
        'scrollbar-none overflow-x-auto',
        className,
      )}
      {...props}
    />
  )
})

export const TabsTrigger = React.forwardRef<
  React.ComponentRef<typeof TabsPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(function TabsTrigger({ className, ...props }, ref) {
  return (
    <TabsPrimitive.Trigger
      ref={ref}
      className={cn(
        'focus-ring flex items-center justify-center gap-1 whitespace-nowrap font-medium text-body text-label disabled:opacity-40 [&_svg]:size-4',
        'group-data-[variant=segmented]/tabs:flex-1 group-data-[variant=segmented]/tabs:rounded-[6px] group-data-[variant=segmented]/tabs:px-3',
        'group-data-[variant=segmented]/tabs:hover:bg-quaternary-fill group-data-[variant=segmented]/tabs:data-[state=active]:bg-bg-elevated group-data-[variant=segmented]/tabs:data-[state=active]:shadow-sm dark:group-data-[variant=segmented]/tabs:data-[state=active]:bg-gray3',
        'group-data-[variant=underline]/tabs:relative group-data-[variant=underline]/tabs:text-secondary-label group-data-[variant=underline]/tabs:data-[state=active]:text-label',
        'group-data-[variant=underline]/tabs:after:absolute group-data-[variant=underline]/tabs:after:inset-x-0 group-data-[variant=underline]/tabs:after:-bottom-px group-data-[variant=underline]/tabs:after:h-0.5 group-data-[variant=underline]/tabs:after:rounded-full group-data-[variant=underline]/tabs:data-[state=active]:after:bg-accent',
        className,
      )}
      {...props}
    />
  )
})

export const TabsContent = React.forwardRef<
  React.ComponentRef<typeof TabsPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(function TabsContent({ className, ...props }, ref) {
  return <TabsPrimitive.Content ref={ref} className={cn('outline-none', className)} {...props} />
})
