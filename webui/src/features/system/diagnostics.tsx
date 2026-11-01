/** 诊断 (self-test) tab: run checks, show the last report grouped, optional pen Z test. */
import { ChevronDown, CircleCheck, CircleMinus, CircleX, ClipboardCopy, PenLine, Play, Stethoscope, TriangleAlert } from 'lucide-react'
import * as React from 'react'
import { useShallow } from 'zustand/react/shallow'
import { isUnavailable, type DiagCheck, type DiagReport, type DiagStatus } from '@/api/collab'
import { queryClient } from '@/api/query'
import { isJobActive, useLive } from '@/api/store'
import { runDiagnostics, useDiagnostics } from '@/api/system'
import { Button, Card, EmptyState, ErrorState, GroupedList, ProgressBar, Skeleton, SkeletonList } from '@/components/ui'
import { collabKeys } from '@/api/collab'
import { cn } from '@/lib/cn'
import { confirm } from '@/lib/confirm'
import { formatRelative, formatTime } from '@/lib/format'
import { toast } from '@/lib/toast'
import { errParts } from '../projects/ext'

const STATUS: Record<DiagStatus, { label: string; icon: typeof CircleCheck; cls: string }> = {
  ok: { label: '通过', icon: CircleCheck, cls: 'text-green' },
  warn: { label: '警告', icon: TriangleAlert, cls: 'text-orange' },
  fail: { label: '失败', icon: CircleX, cls: 'text-red' },
  skip: { label: '跳过', icon: CircleMinus, cls: 'text-gray' },
}
const GROUP_ORDER = ['串口', '固件', '机器', '存储', '网络', '字库', '主机']

/** Check ids (04 §17) → display group. */
function groupOf(id: string): string {
  if (id.startsWith('serial_')) return '串口'
  if (id === 'banner' || id === 'status_latency' || id.startsWith('grbl_')) return '固件'
  if (['travel', 'feed', 'zspeed', 'laser', 'dir', 'pen'].includes(id)) return '机器'
  if (['disk', 'memory', 'data_dir'].includes(id)) return '存储'
  if (id === 'wifi') return '网络'
  if (id === 'fonts') return '字库'
  return '主机'
}

/** The travel check is meaningless when no travel is configured (work_area 0×0: no homing, travel not checked). */
function noTravel(c: DiagCheck) {
  return c.id === 'travel' && /(^|\D)0×0(\D|$)/.test(`${c.detail ?? ''} ${c.message ?? ''}`)
}

function groupChecks(checks: DiagCheck[]) {
  const map = new Map<string, DiagCheck[]>()
  for (const c of checks) {
    if (noTravel(c)) continue
    const g = groupOf(c.id)
    if (!map.has(g)) map.set(g, [])
    map.get(g)!.push(c)
  }
  const rank = (g: string) => {
    const i = GROUP_ORDER.indexOf(g)
    return i < 0 ? 99 : i
  }
  return [...map.entries()].sort((a, b) => rank(a[0]) - rank(b[0]))
}

function reportText(r: DiagReport) {
  const lines = [`PenPlot 自检报告 ${new Date(r.ran_at * 1000).toLocaleString('zh-CN')}`]
  for (const [g, cs] of groupChecks(r.checks)) {
    lines.push('', `[${g}]`)
    for (const c of cs) {
      lines.push(`${STATUS[c.status].label.padEnd(2, ' ')}  ${c.name}${c.message ? `：${c.message}` : ''}`)
      if (c.hint) lines.push(`      建议：${c.hint}`)
    }
  }
  return lines.join('\n')
}

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    // iOS Safari without clipboard permission / insecure context (plain HTTP on LAN)
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    ta.setSelectionRange(0, text.length)
    document.execCommand('copy')
    ta.remove()
  }
}

export function DiagnosticsTab() {
  const diag = useDiagnostics()
  const { job, machine } = useLive(useShallow((s) => ({ job: s.job, machine: s.machine })))
  const jobActive = isJobActive(job)
  const connected = !!machine?.connected
  const [running, setRunning] = React.useState<null | 'basic' | 'pen'>(null)

  const finish = React.useCallback((r: DiagReport | null) => {
    if (r) queryClient.setQueryData(collabKeys.diagnostics, r)
    else void queryClient.invalidateQueries({ queryKey: collabKeys.diagnostics })
    setRunning(null)
    if (r) {
      const fail = r.checks.filter((c) => c.status === 'fail').length
      if (fail) toast.warning(`自检完成：${fail} 项失败`)
      else toast.success('自检完成')
    }
  }, [])


  const run = async (pen: boolean) => {
    if (pen) {
      const ok = await confirm({
        title: '运行抬落笔测试？',
        description: '笔将落下再抬起。请确认纸张与笔位安全，笔下方没有障碍物。',
        confirmLabel: '开始测试',
      })
      if (!ok) return
    }
    setRunning(pen ? 'pen' : 'basic')
    try {
      const r = await runDiagnostics(pen)
      finish(r)
    } catch (e) {
      setRunning(null)
      if (isUnavailable(e)) toast.error('自检尚不可用', { description: '服务端还没有提供自检功能。' })
      else {
        const m = errParts(e, '没能运行自检')
        toast.error(m.title, { description: m.description })
      }
    }
  }

  const unavailable = isUnavailable(diag.error)
  const report = diag.data ?? null
  const counts = report
    ? (['ok', 'warn', 'fail', 'skip'] as DiagStatus[]).map((s) => [s, report.checks.filter((c) => c.status === s).length] as const)
    : []

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      {/* header / run */}
      <Card className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
        <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-blue text-white">
          <Stethoscope className="size-6" strokeWidth={2} aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-headline text-label">系统自检</h2>
          {report ? (
            <p className="text-footnote text-secondary-label" aria-live="polite">
              {counts
                .filter(([s, n]) => n > 0 || s !== 'skip')
                .map(([s, n]) => `${n} ${STATUS[s].label}`)
                .join(' · ')}
              <span className="text-tertiary-label"> · </span>
              <time title={formatTime(report.ran_at)}>{formatRelative(report.ran_at)}运行</time>
            </p>
          ) : (
            <p className="text-footnote text-secondary-label">检查串口、固件、机器状态、存储、网络、字库与服务。</p>
          )}
        </div>
        <div className="flex shrink-0 gap-2">
          {report ? (
            <Button
              icon={<ClipboardCopy />}
              onClick={async () => {
                await copyText(reportText(report))
                toast.success('已复制自检报告')
              }}
            >
              复制报告
            </Button>
          ) : null}
          <Button variant="filled" icon={<Play />} loading={running === 'basic'} disabled={!!running || unavailable} onClick={() => run(false)}>
            运行自检
          </Button>
        </div>
      </Card>
      {running ? <ProgressBar value={null} label="自检进行中" /> : null}

      {/* report */}
      {diag.isLoading ? (
        <div className="flex flex-col gap-4">
          <Skeleton className="h-3 w-24" />
          <SkeletonList rows={4} />
          <SkeletonList rows={3} />
        </div>
      ) : unavailable ? (
        <Card>
          <EmptyState icon={Stethoscope} title="尚不可用（后端尚未提供）" description="服务端还没有自检接口，升级后即可使用。" />
        </Card>
      ) : diag.error ? (
        <Card>
          <ErrorState error={diag.error} onRetry={() => diag.refetch()} />
        </Card>
      ) : !report ? (
        <Card>
          <EmptyState
            icon={Stethoscope}
            title="还没有自检记录"
            description="运行一次自检，在上机前确认串口、固件与存储状态正常。"
            action={
              <Button variant="filled" icon={<Play />} loading={running === 'basic'} disabled={!!running} onClick={() => run(false)}>
                运行自检
              </Button>
            }
          />
        </Card>
      ) : (
        groupChecks(report.checks).map(([g, cs]) => (
          <GroupedList key={g} header={g}>
            {cs.map((c) => (
              <CheckRow key={c.id} check={c} />
            ))}
          </GroupedList>
        ))
      )}

      {/* pen test */}
      {!unavailable ? (
        <GroupedList
          header="抬落笔测试"
          footer={
            jobActive
              ? '任务进行中，不能测试。'
              : !connected
                ? '机器未连接，无法测试抬落笔。'
                : '会实际移动 Z 轴：落笔到 zOn，再抬回 zOff，并检查状态与位置。'
          }
        >
          <div className="flex min-h-[var(--row-h)] items-center gap-3 px-4 py-2">
            <PenLine className="size-5 shrink-0 text-accent" aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="text-body text-label">自检时包含抬落笔动作</p>
              <p className="text-footnote text-secondary-label">用于确认 Z 步进电机与笔夹工作正常</p>
            </div>
            <Button loading={running === 'pen'} disabled={!!running || jobActive || !connected} onClick={() => run(true)} className="pointer-coarse:min-w-11">
              测试…
            </Button>
          </div>
        </GroupedList>
      ) : null}
    </div>
  )
}

function CheckRow({ check: c }: { check: DiagCheck }) {
  const [open, setOpen] = React.useState(false)
  const st = STATUS[c.status] ?? STATUS.skip
  const Icon = st.icon
  const hasDetail = !!c.detail && c.detail !== c.message
  const detailId = React.useId()
  return (
    <div className="px-4 py-2.5">
      <div className="flex items-start gap-3">
        <Icon className={cn('mt-0.5 size-5 shrink-0', st.cls)} strokeWidth={2.25} aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <p className="min-w-0 flex-1 text-body text-label">{c.name}</p>
            <span className={cn('shrink-0 text-footnote font-medium', st.cls)}>{st.label}</span>
          </div>
          {c.message ? <p className="break-words text-footnote text-secondary-label">{c.message}</p> : null}
          {c.hint && c.status !== 'ok' ? (
            <p className={cn('mt-1 rounded-sm px-2 py-1 text-footnote', c.status === 'fail' ? 'bg-red/10 text-on-tint-red' : 'bg-orange/10 text-on-tint-orange')}>
              建议：{c.hint}
            </p>
          ) : null}
          {hasDetail ? (
            <>
              <button
                type="button"
                onClick={() => setOpen(!open)}
                aria-expanded={open}
                aria-controls={detailId}
                className="focus-ring mt-1 inline-flex min-h-6 items-center gap-1 rounded-xs text-footnote text-accent pointer-coarse:min-h-11"
              >
                详细信息
                <ChevronDown className={cn('size-3.5 transition-transform', open && 'rotate-180')} />
              </button>
              {open ? (
                <pre id={detailId} className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-md bg-quaternary-fill p-2 font-mono text-caption text-secondary-label">
                  {c.detail}
                </pre>
              ) : null}
            </>
          ) : null}
        </div>
      </div>
    </div>
  )
}
