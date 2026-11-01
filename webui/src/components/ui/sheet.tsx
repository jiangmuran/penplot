import * as DialogPrimitive from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import * as React from 'react'
import { cn } from '@/lib/cn'
import { useIsCompact } from '@/lib/media'
import { useRegisterBottomSheet } from '@/lib/overlays'
import { DialogOverlay } from './dialog'
import { IconButton } from './icon-button'

export const Sheet = DialogPrimitive.Root
export const SheetTrigger = DialogPrimitive.Trigger
export const SheetClose = DialogPrimitive.Close

export type SheetSide = 'right' | 'left' | 'bottom' | 'auto'
export type SheetDetent = 'medium' | 'large'

export interface SheetContentProps extends Omit<React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>, 'title'> {
  /** `auto` (default) = bottom sheet on compact (<768px), right side panel otherwise. */
  side?: SheetSide
  /** Side-panel width in px (default 420). */
  width?: number
  /** Bottom sheet detent (controlled). Default starts at `defaultDetent`. */
  detent?: SheetDetent
  defaultDetent?: SheetDetent
  onDetentChange?: (d: SheetDetent) => void
  /** Title rendered in the sheet header (also the accessible name). */
  title?: React.ReactNode
  description?: React.ReactNode
  /** Header trailing content (e.g. a 完成 button). Defaults to a close button. */
  headerActions?: React.ReactNode
  hideHeader?: boolean
  /** Render without the dimming overlay (non-modal look). */
  noOverlay?: boolean
}

/**
 * Sheet (02-ux §2.2, §4): side panel on regular widths; on compact a bottom sheet with a drag
 * handle and two detents (medium 50% / large 92%). Drag the handle up/down to switch, down past
 * medium to dismiss.
 */
export const SheetContent = React.forwardRef<React.ComponentRef<typeof DialogPrimitive.Content>, SheetContentProps>(
  function SheetContent(
    { side = 'auto', width = 420, detent, defaultDetent = 'large', onDetentChange, title, description, headerActions, hideHeader, noOverlay, className, children, style, ...props },
    ref,
  ) {
    const compact = useIsCompact()
    const resolved: Exclude<SheetSide, 'auto'> = side === 'auto' ? (compact ? 'bottom' : 'right') : side
    const [innerDetent, setInnerDetent] = React.useState<SheetDetent>(defaultDetent)
    const d = detent ?? innerDetent
    const setD = (v: SheetDetent) => {
      setInnerDetent(v)
      onDetentChange?.(v)
    }
    const [drag, setDrag] = React.useState(0)
    const dragStart = React.useRef<number | null>(null)
    const closeRef = React.useRef<HTMLButtonElement>(null)

    const onPointerDown = (e: React.PointerEvent) => {
      dragStart.current = e.clientY
      ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    }
    const onPointerMove = (e: React.PointerEvent) => {
      if (dragStart.current == null) return
      setDrag(e.clientY - dragStart.current)
    }
    const onPointerUp = () => {
      if (dragStart.current == null) return
      const dy = drag
      dragStart.current = null
      setDrag(0)
      if (dy < -60) setD('large')
      else if (dy > 60) {
        if (d === 'large') setD('medium')
        else closeRef.current?.click()
      }
    }

    const sideClass = {
      // Regular: start below the toolbar so the floating E-stop never covers the header/close button.
      right: 'inset-y-2 right-2 md:top-[var(--estop-safe-top)] rounded-xl data-[state=open]:animate-sheet-in-right data-[state=closed]:animate-sheet-out-right',
      left: 'inset-y-2 left-2 rounded-xl data-[state=open]:animate-sheet-in-left data-[state=closed]:animate-sheet-out-left',
      bottom: cn(
        'inset-x-0 bottom-0 rounded-t-xl pb-safe data-[state=open]:animate-sheet-in-bottom data-[state=closed]:animate-sheet-out-bottom',
        'transition-[height] duration-[var(--dur-sheet)] ease-spring',
      ),
    }[resolved]

    return (
      <DialogPrimitive.Portal>
        {noOverlay ? null : <DialogOverlay />}
        <DialogPrimitive.Content
          ref={ref}
          {...(description ? {} : { 'aria-describedby': undefined })}
          className={cn('surface-elevated fixed z-50 flex flex-col overflow-hidden bg-bg-elevated text-label shadow-lg outline-none', sideClass, className)}
          style={{
            ...(resolved === 'bottom'
              ? { height: d === 'large' ? '92dvh' : '50dvh', transform: drag ? `translateY(${Math.max(drag, -40)}px)` : undefined }
              : { width: `min(${width}px, calc(100vw - 16px))` }),
            ...style,
          }}
          {...props}
          onOpenAutoFocus={(e) => {
            props.onOpenAutoFocus?.(e)
            if (e.defaultPrevented) return
            // Land focus on the sheet itself (screen readers read the title), not on the close
            // button — avoids a bright focus ring on ✕ every time a sheet opens.
            e.preventDefault()
            ;(e.currentTarget as HTMLElement | null)?.focus({ preventScroll: true })
          }}
        >
          {resolved === 'bottom' ? <BottomSheetMarker /> : null}
          {resolved === 'bottom' ? (
            <div
              className="flex h-5 shrink-0 cursor-grab touch-none items-center justify-center active:cursor-grabbing"
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
              onDoubleClick={() => setD(d === 'large' ? 'medium' : 'large')}
              role="separator"
              aria-label="拖动调整高度"
            >
              <span className="h-[5px] w-9 rounded-full bg-tertiary-label" />
            </div>
          ) : null}
          {hideHeader ? (
            title ? <DialogPrimitive.Title className="sr-only">{title}</DialogPrimitive.Title> : null
          ) : (
            <div className={cn('flex shrink-0 items-center gap-2 px-4 pb-2', resolved === 'bottom' ? 'pt-0' : 'pt-4')}>
              <div className="min-w-0 flex-1">
                <DialogPrimitive.Title className="truncate text-headline text-label">{title}</DialogPrimitive.Title>
                {description ? (
                  <DialogPrimitive.Description className="truncate text-footnote text-secondary-label">{description}</DialogPrimitive.Description>
                ) : null}
              </div>
              {headerActions ?? (
                <DialogPrimitive.Close asChild>
                  <IconButton label="关闭" size="sm" variant="gray" noTooltip className="rounded-full">
                    <X strokeWidth={2.5} />
                  </IconButton>
                </DialogPrimitive.Close>
              )}
            </div>
          )}
          <DialogPrimitive.Close ref={closeRef} className="hidden" tabIndex={-1} aria-hidden />
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">{children}</div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    )
  },
)

/** Rendered only while a bottom sheet is open (inside Content): lets the E-stop move out of the way. */
function BottomSheetMarker() {
  useRegisterBottomSheet(true)
  return null
}
