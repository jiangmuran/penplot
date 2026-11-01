import { CircleCheck, CircleX, RefreshCw, Type, X } from 'lucide-react'
import * as React from 'react'
import { errorMessage } from '@/api/client'
import { invalidateFontList } from '@/api/fonts'
import { cancelTask, useTask } from '@/api/tasks'
import { Button, IconButton, ProgressBar } from '@/components/ui'
import { cn } from '@/lib/cn'
import { toast } from '@/lib/toast'
import { useFontsUi, type FontTaskEntry } from './store'

/** `result` of a finished ttf_convert task (see penplot/web/fonts.py FontIndex.convert_ttf). */
interface TtfResult {
  font?: { id?: string; display_name?: string }
  glyphs?: number
  requested?: number
  missing_count?: number
  missing?: string
}

/** Progress rows for background font tasks (TTF conversion, reindex), shown above the list. */
export function FontTaskRows({ className }: { className?: string }) {
  const tasks = useFontsUi((s) => s.tasks)
  if (!tasks.length) return null
  return (
    <div className={cn('flex flex-col gap-2', className)} aria-live="polite">
      {tasks.map((t) => (
        <TaskRow key={t.id} entry={t} />
      ))}
    </div>
  )
}

function TaskRow({ entry }: { entry: FontTaskEntry }) {
  const task = useTask(entry.id)
  const remove = useFontsUi((s) => s.removeTask)
  const [cancelling, setCancelling] = React.useState(false)
  const state = task?.state ?? 'queued'
  const announced = React.useRef(false)

  React.useEffect(() => {
    if (!task || announced.current) return
    if (state === 'done') {
      announced.current = true
      void invalidateFontList()
      if (entry.kind === 'ttf') {
        const r = (task.result ?? {}) as TtfResult
        const name = r.font?.display_name
        const miss = r.missing_count ?? 0
        toast.success(name ? `已安装「${name}」` : `${entry.label}完成`, {
          description:
            `转换了 ${r.glyphs ?? '?'} 个字。` +
            (miss ? `字体里缺 ${miss} 个字（如「${[...(r.missing ?? '')].slice(0, 12).join('')}」），写到这些字时会用默认字体代替。` : ''),
        })
      } else {
        toast.success('字库索引已重建')
      }
      const t = setTimeout(() => remove(entry.id), 4000)
      return () => clearTimeout(t)
    }
    if (state === 'cancelled') {
      announced.current = true
      remove(entry.id)
    }
    if (state === 'failed') {
      announced.current = true
      toast.error(`${entry.label}没有完成`, { description: `${task.error?.message ?? '未知原因'}。可以换个字符集或文件再试。` })
    }
  }, [state, task, entry, remove])

  const pct = task?.progress != null ? Math.round(task.progress * 100) : null
  const Icon = state === 'done' ? CircleCheck : state === 'failed' ? CircleX : entry.kind === 'reindex' ? RefreshCw : Type
  const finished = state === 'done' || state === 'failed' || state === 'cancelled'

  return (
    <div className="flex items-center gap-3 rounded-lg bg-bg-grouped-secondary px-3 py-2.5 shadow-sm">
      <span
        className={cn(
          'flex size-8 shrink-0 items-center justify-center rounded-md',
          state === 'done' ? 'bg-green/15 text-green' : state === 'failed' ? 'bg-red/15 text-red' : 'bg-accent/15 text-accent',
        )}
      >
        <Icon className={cn('size-4', !finished && entry.kind === 'reindex' && 'motion-safe:animate-spin')} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <p className="truncate text-callout font-medium text-label">{entry.label}</p>
          <span className="shrink-0 text-footnote tabular-nums text-secondary-label">
            {state === 'queued' ? '排队中' : state === 'running' ? (pct != null ? `${pct}%` : '进行中') : state === 'done' ? '完成' : state === 'failed' ? '失败' : '已取消'}
          </span>
        </div>
        {state === 'failed' ? (
          <p className="truncate text-footnote text-on-tint-red">{task?.error?.message ?? '未知错误'}</p>
        ) : (
          <>
            <ProgressBar
              value={state === 'done' ? 100 : state === 'queued' ? null : pct}
              tone={state === 'done' ? 'green' : 'accent'}
              label={entry.label}
              valueText={pct != null ? `${pct}%` : undefined}
              className="mt-1.5"
            />
            {task?.message ? <p className="mt-1 truncate text-footnote text-secondary-label">{task.message}</p> : null}
          </>
        )}
      </div>
      {finished ? (
        <IconButton label="关闭" size="sm" onClick={() => remove(entry.id)}>
          <X />
        </IconButton>
      ) : entry.kind === 'ttf' ? (
        <Button
          size="sm"
          variant="gray"
          loading={cancelling}
          onClick={async () => {
            setCancelling(true)
            try {
              await cancelTask(entry.id)
              toast.info('已取消转换')
              remove(entry.id)
            } catch (e) {
              toast.error('取消失败', { description: errorMessage(e) })
            } finally {
              setCancelling(false)
            }
          }}
        >
          取消
        </Button>
      ) : null}
    </div>
  )
}
