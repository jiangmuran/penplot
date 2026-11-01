import * as AD from '@radix-ui/react-alert-dialog'
import * as React from 'react'
import { useConfirmStore } from '@/lib/confirm'
import { cn } from '@/lib/cn'
import { buttonVariants } from './button'
import { overlayClass } from './dialog'

export const AlertDialog = AD.Root
export const AlertDialogTrigger = AD.Trigger

export interface AlertDialogContentProps {
  title: React.ReactNode
  description?: React.ReactNode
  confirmLabel?: string
  cancelLabel?: string
  destructive?: boolean
  onConfirm: () => void
  onCancel?: () => void
  icon?: React.ReactNode
  children?: React.ReactNode
  items?: string[]
  alertOnly?: boolean
}

/**
 * HIG alert: title states the consequence; Cancel has default focus; destructive confirm is red text.
 * Prefer the imperative `confirm()` from '@/lib/confirm' for one-off confirmations.
 */
export function AlertDialogContent({
  title, description, confirmLabel = '确定', cancelLabel = '取消', destructive, onConfirm, onCancel, icon, children, items, alertOnly,
}: AlertDialogContentProps) {
  const cancelRef = React.useRef<HTMLButtonElement>(null)
  return (
    <AD.Portal>
      <AD.Overlay className={cn(overlayClass, 'z-[80]')} />
      <AD.Content
        onOpenAutoFocus={(e) => {
          e.preventDefault()
          cancelRef.current?.focus()
        }}
        className={cn(
          'fixed left-1/2 top-1/2 z-[80] w-[calc(100vw-48px)] max-w-[340px] -translate-x-1/2 -translate-y-1/2',
          'mat-thick rounded-xl p-5 pt-6 text-center shadow-lg outline-none pointer-coarse:max-w-[320px]',
          'data-[state=open]:animate-pop-in data-[state=closed]:animate-pop-out',
        )}
      >
        {icon ? <div className="mb-3 flex justify-center">{icon}</div> : null}
        <AD.Title className="text-headline text-label">{title}</AD.Title>
        {description ? <AD.Description className="mt-1.5 text-callout text-secondary-label">{description}</AD.Description> : <AD.Description className="sr-only">{String(title)}</AD.Description>}
        {items?.length ? (
          <ul className="mt-3 max-h-48 list-disc overflow-y-auto rounded-md bg-quaternary-fill py-2 pl-7 pr-3 text-left text-footnote text-label">
            {items.map((it, i) => (
              <li key={i} className="py-0.5">
                {it}
              </li>
            ))}
          </ul>
        ) : null}
        {children}
        <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row">
          <AD.Cancel ref={cancelRef} onClick={onCancel} className={cn(buttonVariants({ variant: alertOnly ? 'filled' : 'gray', size: 'lg', block: true }), 'flex-1')}>
            {alertOnly ? (cancelLabel === '取消' ? '知道了' : cancelLabel) : cancelLabel}
          </AD.Cancel>
          {alertOnly ? null : <AD.Action
            onClick={onConfirm}
            className={cn(
              buttonVariants({ variant: destructive ? 'gray' : 'filled', size: 'lg', block: true }),
              'flex-1',
              destructive && 'text-red font-semibold',
            )}
          >
            {confirmLabel}
          </AD.Action>}
        </div>
      </AD.Content>
    </AD.Portal>
  )
}

/** Renders the imperative `confirm()` dialogs. Mounted once in the shell. */
export function ConfirmHost() {
  const current = useConfirmStore((s) => s.current)
  const close = useConfirmStore((s) => s.close)
  return (
    <AlertDialog open={!!current} onOpenChange={(o) => !o && close(false)}>
      {current ? (
        <AlertDialogContent
          title={current.title}
          description={current.description}
          confirmLabel={current.confirmLabel}
          cancelLabel={current.cancelLabel}
          destructive={current.destructive}
          items={current.items}
          alertOnly={current.alertOnly}
          onConfirm={() => close(true)}
          onCancel={() => close(false)}
        />
      ) : null}
    </AlertDialog>
  )
}
