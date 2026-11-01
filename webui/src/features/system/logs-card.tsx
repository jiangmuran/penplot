/** Service log viewer (journalctl -u penplot-web, 03 §4.8 GET /system/logs). */
import { Download, RefreshCw, ScrollText } from 'lucide-react'
import * as React from 'react'
import { isApiError } from '@/api/client'
import { saveText } from '@/api/download'
import { useServiceLogs, type LogEntry } from '@/api/system'
import { Card, CardHeader, EmptyState, ErrorState, IconButton, SearchField, Segmented, Skeleton } from '@/components/ui'
import { VirtualList } from '@/features/console/virtual-list'
import { cn } from '@/lib/cn'
import { toDate } from '@/lib/format'

type Level = 'all' | 'warn' | 'err'
const PRIORITY: Record<Level, number | undefined> = { all: undefined, warn: 4, err: 3 }

const LEVEL = (p: number) =>
  p <= 3 ? { label: '错误', cls: 'text-on-tint-red bg-red/15' } : p === 4 ? { label: '警告', cls: 'text-on-tint-orange bg-orange/15' } : p === 5 ? { label: '注意', cls: 'text-on-tint-blue bg-blue/15' } : p === 7 ? { label: '调试', cls: 'text-secondary-label bg-fill' } : { label: '信息', cls: 'text-secondary-label bg-fill' }

function stamp(ts: number) {
  const d = toDate(ts)
  if (!d) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

export function LogsCard() {
  const [level, setLevel] = React.useState<Level>('all')
  const [q, setQ] = React.useState('')
  const logs = useServiceLogs({ n: 1000, priority: PRIORITY[level] })
  const lines = React.useMemo(() => {
    const needle = q.trim().toLowerCase()
    const all = logs.data ?? []
    return needle ? all.filter((l) => l.message.toLowerCase().includes(needle)) : all
  }, [logs.data, q])

  const download = () => {
    const text = (logs.data ?? []).map((l: LogEntry) => `${new Date(l.ts * 1000).toISOString()} [${LEVEL(l.priority).label}] ${l.message}`).join('\n')
    saveText(text, `penplot-web-${new Date().toISOString().slice(0, 10)}.log`)
  }

  const unavailable = isApiError(logs.error) && [403, 404, 500, 501].includes(logs.error.status)

  return (
    <Card className="flex flex-col overflow-hidden">
      <CardHeader
        title="服务日志"
        subtitle="journalctl -u penplot-web"
        actions={
          <>
            <IconButton label="刷新" onClick={() => logs.refetch()} loading={logs.isFetching && !logs.isLoading}>
              <RefreshCw />
            </IconButton>
            <IconButton label="下载日志" onClick={download} disabled={!logs.data?.length}>
              <Download />
            </IconButton>
          </>
        }
      />
      <div className="flex flex-wrap items-center gap-2 px-4 pb-3">
        <Segmented
          size="sm"
          aria-label="日志级别"
          value={level}
          onValueChange={setLevel}
          options={[
            { value: 'all', label: '全部' },
            { value: 'warn', label: '警告' },
            { value: 'err', label: '错误' },
          ]}
        />
        <SearchField value={q} onValueChange={setQ} placeholder="过滤日志" aria-label="过滤日志" className="min-w-40 flex-1 sm:max-w-64" />
      </div>
      <div className="hairline-t h-80 bg-bg-grouped-secondary">
        {logs.isLoading ? (
          <div className="flex flex-col gap-2 p-4" role="status" aria-label="加载中">
            {Array.from({ length: 8 }, (_, i) => <Skeleton key={i} className="h-3" style={{ width: `${90 - ((i * 13) % 40)}%` }} />)}
          </div>
        ) : unavailable ? (
          <EmptyState icon={ScrollText} title="日志尚不可用" description="服务需要加入 systemd-journal 组才能读取日志，或当前不是 systemd 部署。" className="py-8" />
        ) : logs.error ? (
          <ErrorState error={logs.error} onRetry={() => logs.refetch()} className="py-8" />
        ) : (
          <VirtualList
            count={lines.length}
            rowHeight={22}
            className="h-full font-mono text-caption"
            follow
            role="log"
            aria-label="服务日志"
            empty={<EmptyState icon={ScrollText} title={q ? '没有匹配的日志' : '暂无日志'} description={q ? undefined : '开发模式或非 systemd 环境下没有服务日志。'} className="py-8" />}
            renderRow={(i) => {
              const l = lines[i]
              const lv = LEVEL(l.priority)
              return (
                <div className={cn('flex h-full items-center gap-2 px-4 hover:bg-quaternary-fill', l.priority <= 3 && 'bg-red/5')} title={l.message}>
                  <span className="shrink-0 tabular-nums text-secondary-label">{stamp(l.ts)}</span>
                  <span className={cn('shrink-0 rounded-xs px-1 font-sans text-[12px] font-semibold leading-4', lv.cls)}>{lv.label}</span>
                  <span className={cn('min-w-0 truncate', l.priority <= 3 ? 'text-red' : 'text-label')}>{l.message}</span>
                </div>
              )
            }}
          />
        )}
      </div>
    </Card>
  )
}
