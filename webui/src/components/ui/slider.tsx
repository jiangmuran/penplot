import * as SliderPrimitive from '@radix-ui/react-slider'
import * as React from 'react'
import { cn } from '@/lib/cn'

/** HIG slider: 4px track, accent fill, white 20px knob (28px on touch). Pair with a NumberField. */
export const Slider = React.forwardRef<
  React.ComponentRef<typeof SliderPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof SliderPrimitive.Root> & { 'aria-label'?: string }
>(function Slider({ className, 'aria-label': ariaLabel, ...props }, ref) {
  const count = (props.value ?? props.defaultValue ?? [0]).length
  return (
    <SliderPrimitive.Root
      ref={ref}
      className={cn(
        'relative flex h-5 w-full touch-none select-none items-center data-[disabled]:opacity-40 pointer-coarse:h-11',
        className,
      )}
      {...props}
    >
      <SliderPrimitive.Track className="relative h-1 grow overflow-hidden rounded-full bg-fill">
        <SliderPrimitive.Range className="absolute h-full bg-accent" />
      </SliderPrimitive.Track>
      {Array.from({ length: count }, (_, i) => (
        <SliderPrimitive.Thumb
          key={i}
          aria-label={ariaLabel}
          className={cn(
            'block size-5 rounded-full bg-white shadow-[0_0.5px_4px_rgb(0_0_0/0.12),0_6px_13px_rgb(0_0_0/0.12),0_0_0_0.5px_rgb(0_0_0/0.04)]',
            'transition-transform duration-[var(--dur-instant)] active:scale-110 focus-visible:outline-[3px] focus-visible:outline-accent/50 pointer-coarse:size-7',
          )}
        />
      ))}
    </SliderPrimitive.Root>
  )
})
