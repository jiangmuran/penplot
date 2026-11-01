import * as SwitchPrimitive from '@radix-ui/react-switch'
import * as React from 'react'
import { cn } from '@/lib/cn'

/** iOS/macOS switch (accent when on). 26×15 with a mouse, 51×31 on touch. */
export const Switch = React.forwardRef<
  React.ComponentRef<typeof SwitchPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof SwitchPrimitive.Root>
>(function Switch({ className, ...props }, ref) {
  return (
    <SwitchPrimitive.Root
      ref={ref}
      className={cn(
        'focus-ring peer relative inline-flex h-[18px] w-8 shrink-0 items-center rounded-full p-[2px] transition-colors duration-[var(--dur-base)] ease-standard',
        'bg-fill data-[state=checked]:bg-accent disabled:opacity-40',
        'pointer-coarse:h-[31px] pointer-coarse:w-[51px]',
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        className={cn(
          'pointer-events-none block size-[14px] rounded-full bg-white shadow-[0_3px_8px_rgb(0_0_0/0.15),0_1px_1px_rgb(0_0_0/0.16)]',
          'transition-transform duration-[var(--dur-base)] ease-spring data-[state=checked]:translate-x-[14px]',
          'pointer-coarse:size-[27px] pointer-coarse:data-[state=checked]:translate-x-5',
        )}
      />
    </SwitchPrimitive.Root>
  )
})
