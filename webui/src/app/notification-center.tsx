import { Bell, CircleAlert, CircleCheck, Info, TriangleAlert } from 'lucide-react'
import * as React from 'react'
import { Button, IconButton, Popover, PopoverContent, PopoverTrigger } from '@/components/ui'
import { cn } from '@/lib/cn'
import { formatRelative } from '@/lib/format'
import { useToastStore, type ToastLevel } from '@/lib/toast'

const ICON: Record<ToastLevel, { i: typeof Info; c: string }> = {
  info: { i: Info, c: 'text-accent' },
  success: { i: CircleCheck, c: 'text-green' },
  warning: { i: TriangleAlert, c: 'text-orange' },
  error: { i: CircleAlert, c: 'text-red' },
}

/** Bell → recent notifications (all toasts are recorded here). */
export function NotificationCenter({ size = 'md' }: { size?: 'md' | 'lg' }) {
  const history = useToastStore((s) => s.history)
  const markAllRead = useToastStore((s) => s.markAllRead)
  const clear = useToastStore((s) => s.clearHistory)
  const unread = history.filter((h) => !h.read).length
  const [open, setOpen] = React.useState(false)
  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (!o) markAllRead()
      }}
    >
      <PopoverTrigger asChild>
        <IconButton label={unread ? `通知（${unread} 条未读）` : '通知'} size={size} className="relative">
          <Bell />
          {unread ? <span className="absolute right-1 top-1 size-2 rounded-full bg-red ring-2 ring-bg pointer-coarse:right-2 pointer-coarse:top-2" aria-hidden /> : null}
        </IconButton>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[340px] p-0">
        <div className="flex items-center px-4 pb-2 pt-3">
          <h2 className="flex-1 text-headline">通知</h2>
          {history.length ? (
            <Button size="sm" variant="plain" onClick={clear}>
              全部清除
            </Button>
          ) : null}
        </div>
        <div className="max-h-[min(420px,60dvh)] overflow-y-auto pb-1">
          {history.length === 0 ? (
            <p className="px-4 pb-6 pt-4 text-center text-footnote text-secondary-label">暂无通知</p>
          ) : (
            history.map((h) => {
              const { i: Icon, c } = ICON[h.level]
              return (
                <div key={h.id} className={cn('flex gap-2.5 px-4 py-2 [&+&]:hairline-t', !h.read && 'bg-accent/5')}>
                  <Icon className={cn('mt-0.5 size-4 shrink-0', c)} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                      <span className="min-w-0 flex-1 truncate text-headline font-medium">
                        {h.title}
                        {h.count > 1 ? <span className="ml-1 text-secondary-label">×{h.count}</span> : null}
                      </span>
                      <time className="shrink-0 text-caption text-secondary-label">{formatRelative(h.createdAt)}</time>
                    </div>
                    {h.description ? <p className="break-words text-footnote text-secondary-label">{h.description}</p> : null}
                  </div>
                </div>
              )
            })
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
