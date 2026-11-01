import * as ToastPrimitive from '@radix-ui/react-toast'
import { CircleAlert, CircleCheck, Info, TriangleAlert, X } from 'lucide-react'
import { cn } from '@/lib/cn'
import { useIsCompact } from '@/lib/media'
import { useToastStore, type ToastItem, type ToastLevel } from '@/lib/toast'

const ICONS: Record<ToastLevel, { icon: typeof Info; cls: string }> = {
  info: { icon: Info, cls: 'text-accent' },
  success: { icon: CircleCheck, cls: 'text-green' },
  warning: { icon: TriangleAlert, cls: 'text-orange' },
  error: { icon: CircleAlert, cls: 'text-red' },
}

/** Toast viewport: regular top-right under the toolbar; compact top-centre. Mounted once in the shell. */
export function Toaster() {
  const toasts = useToastStore((s) => s.toasts)
  const dismiss = useToastStore((s) => s.dismiss)
  const compact = useIsCompact()
  return (
    <ToastPrimitive.Provider swipeDirection={compact ? 'up' : 'right'} label="通知">
      {toasts.map((t) => (
        <ToastCard key={`${t.id}:${t.rev}`} t={t} onDismiss={() => dismiss(t.id)} />
      ))}
      <ToastPrimitive.Viewport
        className={cn(
          'fixed z-[70] flex max-h-dvh w-full flex-col gap-2 outline-none',
          compact
            ? 'left-1/2 top-[calc(env(safe-area-inset-top)+8px)] max-w-[calc(100vw-16px)] -translate-x-1/2 items-center'
            : 'right-3 top-[calc(var(--toolbar-h)+8px)] max-w-[360px] items-end',
        )}
      />
    </ToastPrimitive.Provider>
  )
}

function ToastCard({ t, onDismiss }: { t: ToastItem; onDismiss: () => void }) {
  const { icon: Icon, cls } = ICONS[t.level]
  return (
    <ToastPrimitive.Root
      duration={Number.isFinite(t.duration) ? t.duration : 1e9}
      type={t.level === 'error' ? 'foreground' : 'background'}
      onOpenChange={(open) => !open && onDismiss()}
      className={cn(
        'mat-thick group pointer-events-auto flex w-full max-w-[360px] items-start gap-2.5 rounded-xl py-2.5 pl-3 pr-2 shadow-md',
        'data-[state=open]:animate-toast-in data-[state=closed]:animate-toast-out',
        'data-[swipe=move]:translate-x-[var(--radix-toast-swipe-move-x)] data-[swipe=move]:translate-y-[var(--radix-toast-swipe-move-y)] data-[swipe=cancel]:translate-x-0 data-[swipe=cancel]:transition-transform data-[swipe=end]:animate-toast-out',
      )}
    >
      <Icon className={cn('mt-px size-[18px] shrink-0', cls)} strokeWidth={2.25} aria-hidden />
      <div className="min-w-0 flex-1">
        <ToastPrimitive.Title className="text-headline text-label">
          {t.title}
          {t.count > 1 ? <span className="ml-1.5 rounded-full bg-fill px-1.5 text-caption font-medium text-secondary-label tabular-nums">×{t.count}</span> : null}
        </ToastPrimitive.Title>
        {t.description ? <ToastPrimitive.Description className="mt-0.5 break-words text-callout text-secondary-label">{t.description}</ToastPrimitive.Description> : null}
      </div>
      {t.action ? (
        <ToastPrimitive.Action altText={t.action.label} asChild>
          <button type="button" onClick={t.action.onClick} className="focus-ring shrink-0 rounded-md px-2 py-1 text-headline text-accent hover:bg-accent/10">
            {t.action.label}
          </button>
        </ToastPrimitive.Action>
      ) : null}
      <ToastPrimitive.Close aria-label="关闭" className="focus-ring flex size-6 shrink-0 items-center justify-center rounded-full text-tertiary-label opacity-60 hover:bg-quaternary-fill hover:text-secondary-label group-hover:opacity-100 pointer-coarse:size-8 pointer-coarse:opacity-100">
        <X className="size-3.5" strokeWidth={2.5} />
      </ToastPrimitive.Close>
    </ToastPrimitive.Root>
  )
}
