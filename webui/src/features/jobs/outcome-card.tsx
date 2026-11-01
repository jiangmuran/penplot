/**
 * What happened to a failed/stopped job and what to do next (review §1.6, §3.10):
 * 发生了什么 · 为什么 · 怎么办 — 「从第 N 行续写」 is the primary action; codes live in 技术详情.
 */
import { ChevronDown, CornerDownRight, FileSearch, LifeBuoy, RotateCcw, SkipForward, Terminal } from 'lucide-react'
import * as React from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api } from '@/api/client'
import { useJobActions } from '@/api/jobs'
import { useLive } from '@/api/store'
import type { Job } from '@/api/types'
import {
  Button, Card, Dialog, DialogBody, DialogContent, DialogHeader, DialogTitle, NumberField, Skeleton,
} from '@/components/ui'
import { explainGrblLine, grblCodeHref } from '@/features/console/grbl-codes'
import { cn } from '@/lib/cn'
import { formatDuration } from '@/lib/format'
import { toast } from '@/lib/toast'
import { HelpLink } from '@/features/help/HelpLink'
import { isRecoverable } from './recovery-wizard'

interface Story {
  what: string
  why: string
  todo: string
}

function story(job: Job): Story {
  const r = job.reason ?? ''
  const err = job.errors?.[0]
  const pct = Math.floor(job.percent ?? (job.total_lines ? (100 * (job.acked_line ?? 0)) / job.total_lines : 0))
  const at = `写到 ${pct}%（${formatDuration(job.elapsed_s)}）`
  if (r === 'gcode_error' || (err && job.status === 'failed' && !r.startsWith('alarm'))) {
    const x = err ? explainGrblLine(err.reply) : null
    const cmd = err?.cmd?.trim().split(/\s+/)[0]
    return {
      what: err ? `${at}后停止：控制板不认识第 ${err.line ?? '?'} 行的命令${cmd ? ` ${cmd}` : ''}。` : `${at}后因为 G 代码错误停止。`,
      why: x?.hint || '可能是导入的 G 代码不是给 GRBL 写字机用的。',
      todo: '可以跳过这一行接着写，或者查看这一行的内容。',
    }
  }
  if (r.startsWith('alarm')) {
    const x = explainGrblLine(`ALARM:${r.slice(6)}`)
    return { what: `${at}后写字机报警${x ? `：${x.title}` : ''}。`, why: x?.hint || '控制板进入了报警锁定。', todo: x?.fix || '先解锁并抬笔，确认原点后从中断处续写。' }
  }
  switch (r) {
    case 'estop':
      return { what: `${at}后按了急停。`, why: '急停会立刻停住电机，原点可能已经丢失。', todo: '用恢复向导抬笔、确认原点，然后从中断处续写。' }
    case 'serial_lost':
      return { what: `${at}后和写字机的 USB 连接断了。`, why: 'USB 线松动、控制板断电或复位都会这样，坐标会丢失。', todo: '重新连接，按恢复向导把笔放回原点，然后续写。' }
    case 'process_crash':
    case 'shutdown':
      return { what: `${at}后服务重启了。`, why: '服务被重启或意外退出，任务被中断。', todo: '用恢复向导检查笔和原点，然后续写。' }
    case 'user_stop':
      return { what: `${at}后被手动停止。`, why: '笔已经抬起并回到原点。', todo: '如果纸没动，可以从停下的地方续写。' }
    case 'alarm_locked':
      return { what: '没能开始：写字机处于报警锁定。', why: '控制板需要先解锁。', todo: '到「控制」页解锁后再开始。' }
    case 'not_connected':
      return { what: '没能开始：写字机没有连接。', why: '', todo: '到「控制」页连接后再开始。' }
    default:
      return { what: `${at}后停止。`, why: '', todo: '可以从停下的地方续写。' }
  }
}

export function OutcomeCard({ job, onWizard }: { job: Job; onWizard: () => void }) {
  const navigate = useNavigate()
  const { retry } = useJobActions()
  const originValid = useLive((s) => !!s.machine?.origin_valid)
  const acked = job.acked_line ?? 0
  const err = job.errors?.[0]
  const [from, setFrom] = React.useState<number>(job.can_retry_from ?? Math.max(1, acked))
  const [showLine, setShowLine] = React.useState<number | null>(null)
  const s = story(job)
  const recoverable = isRecoverable(job)
  const doRetry = (n?: number) =>
    retry.mutate(
      { id: job.id, from_line: n },
      {
        onSuccess: (j) => {
          toast.success(n ? `已创建续写任务（从第 ${n} 行）` : '已加入队列', { description: j?.name })
          navigate(`/jobs/${j.id}`)
        },
      },
    )

  return (
    <Card className="flex flex-col gap-3 border-l-4 border-orange p-4" role="region" aria-label="处理建议">
      <div className="flex flex-col gap-1">
        <p className="text-headline text-label">{s.what}</p>
        {s.why ? <p className="text-subheadline text-secondary-label">{s.why}</p> : null}
        <p className="text-subheadline text-label">{s.todo}</p>
      </div>

      <div className="flex flex-wrap items-center gap-2 rounded-lg bg-quaternary-fill p-2.5">
        <span className="text-subheadline text-label">从第</span>
        <NumberField aria-label="从第几行续写" value={from} onChange={setFrom} min={1} max={job.total_lines} step={1} className="w-36" />
        <span className="text-subheadline text-label">行续写</span>
        <HelpLink topic="offset" />
        <span className="text-footnote text-secondary-label">（共 {job.total_lines.toLocaleString()} 行）</span>
        <Button
          variant="filled"
          icon={<CornerDownRight />}
          className="ml-auto"
          disabled={!originValid}
          loading={retry.isPending && retry.variables?.from_line === from}
          onClick={() => doRetry(from)}
        >
          续写
        </Button>
      </div>
      {!originValid ? (
        <p className="text-footnote text-on-tint-orange">
          原点已经失效（控制板复位过），直接续写会错位。先用恢复向导把笔放回原来的起点并设为原点。
        </p>
      ) : (
        <p className="text-footnote text-secondary-label">会先抬笔，移动到这一行之前的位置再落笔。纸不要移动。</p>
      )}

      <div className="flex flex-wrap gap-2">
        {recoverable ? (
          <Button variant={originValid ? 'gray' : 'filled'} icon={<LifeBuoy />} onClick={onWizard}>
            恢复向导…
          </Button>
        ) : null}
        {err?.line ? (
          <>
            <Button variant="gray" icon={<SkipForward />} disabled={!originValid} onClick={() => doRetry(err.line! + 1)}>
              跳过这行续写
            </Button>
            <Button variant="gray" icon={<FileSearch />} onClick={() => setShowLine(err.line!)}>
              查看第 {err.line} 行
            </Button>
          </>
        ) : null}
        <Button variant="gray" icon={<RotateCcw />} loading={retry.isPending && !retry.variables?.from_line} onClick={() => doRetry()}>
          从头重写
        </Button>
      </div>

      <TechDetails job={job} />
      <GcodeLineDialog job={job} line={showLine} onClose={() => setShowLine(null)} />
    </Card>
  )
}

function TechDetails({ job }: { job: Job }) {
  const [open, setOpen] = React.useState(false)
  const errors = job.errors ?? []
  return (
    <div>
      <button type="button" className="focus-ring inline-flex items-center gap-1 rounded-sm text-footnote text-secondary-label hover:text-label" aria-expanded={open} onClick={() => setOpen(!open)}>
        技术详情 <ChevronDown className={cn('size-3.5 transition-transform', open && 'rotate-180')} />
      </button>
      {open ? (
        <div className="mt-2 flex flex-col gap-1.5 rounded-md bg-quaternary-fill p-2.5 text-footnote text-secondary-label">
          <p>原因代码：<code className="font-mono text-label">{job.reason ?? '—'}</code> · 已确认 {job.acked_line ?? 0} 行 · 任务 {job.id}</p>
          {errors.map((e, i) => {
            const x = explainGrblLine(e.reply)
            return (
              <p key={i}>
                第 {e.line ?? '?'} 行 <code className="font-mono text-label">{e.cmd}</code> → <code className="font-mono text-red">{e.reply}</code>
                {x ? (
                  <>
                    {' '}· {x.title} ·{' '}
                    <Link className="inline-flex items-center gap-0.5 text-accent hover:underline" to={grblCodeHref(x.kind, x.code)}>
                      <Terminal className="size-3" /> 在调试页查看
                    </Link>
                  </>
                ) : null}
              </p>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}

function GcodeLineDialog({ job, line, onClose }: { job: Job; line: number | null; onClose: () => void }) {
  const [text, setText] = React.useState<string[] | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  React.useEffect(() => {
    if (line == null || text) return
    api
      .get<string>(`/jobs/${job.id}/gcode`, { headers: { Accept: 'text/plain' }, timeoutMs: 60_000 })
      .then((t) => setText(String(t).split('\n')))
      .catch(() => setError('读不到这份 G 代码。'))
  }, [line, job.id, text])
  const from = Math.max(1, (line ?? 1) - 5)
  return (
    <Dialog open={line != null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>第 {line} 行附近的 G 代码</DialogTitle>
        </DialogHeader>
        <DialogBody className="pb-5">
          {error ? (
            <p className="text-callout text-secondary-label">{error}</p>
          ) : !text ? (
            <Skeleton className="h-40 w-full" />
          ) : (
            <pre className="overflow-x-auto rounded-md bg-quaternary-fill p-2 font-mono text-footnote leading-6">
              {text.slice(from - 1, (line ?? 1) + 5).map((l, i) => {
                const n = from + i
                return (
                  <div key={n} className={cn('flex gap-3 px-1', n === line && 'rounded-sm bg-red/15 text-on-tint-red')}>
                    <span className="w-12 shrink-0 select-none text-right text-secondary-label tabular-nums">{n}</span>
                    <span>{l || ' '}</span>
                  </div>
                )
              })}
            </pre>
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}
