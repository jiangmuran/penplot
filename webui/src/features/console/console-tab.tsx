import { ArrowDown, CornerDownLeft, Download, Filter, Pause, Play, PlugZap, Trash2 } from 'lucide-react'
import * as React from 'react'
import { useNavigate } from 'react-router-dom'
import { useShallow } from 'zustand/react/shallow'
import { ApiError } from '@/api/client'
import { describeError } from '@/api/errors'
import { useLease } from '@/api/collab'
import { saveText } from '@/api/download'
import { REALTIME, sendCommand, sendRealtime, type RealtimeByte } from '@/api/grbl'
import { isJobActive, useLive } from '@/api/store'
import type { LogLine } from '@/api/types'
import { useWsTopics } from '@/api/ws'
import {
  Button, DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup,
  DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger, IconButton, SearchField, Segmented, Spinner, Switch, Tooltip,
} from '@/components/ui'
import { cn } from '@/lib/cn'
import { confirm } from '@/lib/confirm'
import { useIsCompact } from '@/lib/media'
import { toast } from '@/lib/toast'
import { explainGrblLine } from './grbl-codes'
import { useFillHeight } from './use-fill-height'
import { VirtualList, type VirtualListHandle } from './virtual-list'

type DirFilter = 'all' | '>' | '<' | '!'
const ROW_H = 20
const HISTORY_KEY = 'penplot.console.history'
const PREFS_KEY = 'penplot.console.prefs'

function isStatusLine(l: LogLine) {
  const t = l.text.trim()
  return (l.dir === '>' && t === '?') || (l.dir === '<' && t.startsWith('<') && t.endsWith('>'))
}

function fmtTime(t: number, ms: boolean) {
  const d = new Date(t * 1000)
  const p = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}${ms ? '.' + p(d.getMilliseconds(), 3) : ''}`
}

function loadPrefs(): { hideStatus: boolean; dir: DirFilter } {
  try {
    const v = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}')
    return { hideStatus: v.hideStatus ?? true, dir: (['all', '>', '<', '!'] as const).includes(v.dir) ? v.dir : 'all' }
  } catch {
    return { hideStatus: true, dir: 'all' }
  }
}

function loadHistory(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '[]')
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(-50) : []
  } catch {
    return []
  }
}

function Highlight({ text, q }: { text: string; q: string }) {
  if (!q) return <>{text}</>
  const lower = text.toLowerCase()
  const ql = q.toLowerCase()
  const out: React.ReactNode[] = []
  let i = 0
  for (;;) {
    const j = lower.indexOf(ql, i)
    if (j < 0) break
    if (j > i) out.push(text.slice(i, j))
    out.push(
      <mark key={j} className="rounded-[2px] bg-yellow/40 text-inherit">
        {text.slice(j, j + q.length)}
      </mark>,
    )
    i = j + q.length
  }
  out.push(text.slice(i))
  return <>{out}</>
}

const DIR_META: Record<LogLine['dir'], { glyph: string; cls: string; label: string }> = {
  '>': { glyph: '→', cls: 'text-accent', label: '发送' },
  '<': { glyph: '←', cls: 'text-secondary-label', label: '接收' },
  '!': { glyph: '•', cls: 'text-orange', label: '事件' },
}

const LogRow = React.memo(function LogRow({ line, q, ms }: { line: LogLine; q: string; ms: boolean }) {
  const ex = line.dir === '<' || line.dir === '!' ? explainGrblLine(line.text) : null
  const dir = DIR_META[line.dir] ?? DIR_META['!']
  return (
    <div
      className={cn(
        'flex h-5 items-center gap-2 whitespace-pre px-3 font-mono text-footnote leading-5 hover:bg-quaternary-fill',
        ex && 'bg-red/[0.06]',
      )}
      title={ex ? `${ex.title}${ex.hint ? '：' + ex.hint : ''}${ex.fix ? '\n处理：' + ex.fix : ''}` : undefined}
    >
      <span className="shrink-0 tabular-nums text-secondary-label">{fmtTime(line.t, ms)}</span>
      <span className={cn('w-3 shrink-0 text-center', dir.cls)} aria-label={dir.label}>
        {dir.glyph}
      </span>
      <span
        className={cn(
          'min-w-0 truncate',
          ex ? 'text-red' : line.dir === '>' ? 'text-accent' : line.dir === '!' ? 'text-on-tint-orange' : 'text-label',
          ex?.kind === 'alarm' && 'font-bold',
        )}
      >
        <Highlight text={line.text} q={q} />
        {ex ? <span className="ml-2 font-sans text-secondary-label">{ex.title}</span> : null}
      </span>
    </div>
  )
})

export function ConsoleTab() {
  useWsTopics(['log'])
  const navigate = useNavigate()
  const compact = useIsCompact()
  const { log, dropped, machine, job, conn } = useLive(
    useShallow((s) => ({ log: s.log, dropped: s.logDropped, machine: s.machine, job: s.job, conn: s.conn })),
  )
  const connected = conn === 'open' && !!machine?.connected
  const jobActive = isJobActive(job) || !!machine?.busy
  const lease = useLease()
  const leaseBlock = lease.canControl ? null : `控制权在 ${lease.holderName ?? '其他用户'} 手中`

  const [prefs, setPrefs] = React.useState(loadPrefs)
  React.useEffect(() => localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)), [prefs])
  const [q, setQ] = React.useState('')
  const [follow, setFollow] = React.useState(true)
  const [atBottom, setAtBottom] = React.useState(true)

  const lines = React.useMemo(() => {
    const ql = q.trim().toLowerCase()
    return log.filter(
      (l) =>
        (!prefs.hideStatus || !isStatusLine(l)) &&
        (prefs.dir === 'all' || l.dir === prefs.dir) &&
        (!ql || l.text.toLowerCase().includes(ql)),
    )
  }, [log, prefs, q])

  const listRef = React.useRef<VirtualListHandle>(null)
  const wrapRef = React.useRef<HTMLDivElement>(null)
  const height = useFillHeight(wrapRef, 32) // = the Page's pb-8, so #main never scrolls by a few px

  const exportLog = () => {
    const text = log.map((l) => `${fmtTime(l.t, true)} ${l.dir} ${l.text}`).join('\n')
    const d = new Date()
    saveText(text + '\n', `penplot-serial-${d.toISOString().slice(0, 19).replace(/[:T]/g, '-')}.txt`)
  }
  const clearLog = () => {
    const prev = useLive.getState().log
    useLive.getState().clearLog()
    toast({ title: '已清空控制台', duration: 5000, action: { label: '撤销', onClick: () => useLive.getState().appendLog(prev) } })
  }

  const filterMenu = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton label="筛选" active={prefs.dir !== 'all' || !prefs.hideStatus}>
          <Filter />
        </IconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>方向</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={prefs.dir} onValueChange={(v) => setPrefs((p) => ({ ...p, dir: v as DirFilter }))}>
          <DropdownMenuRadioItem value="all">全部</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value=">">发送</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="<">接收</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="!">事件</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuCheckboxItem checked={prefs.hideStatus} onCheckedChange={(v) => setPrefs((p) => ({ ...p, hideStatus: !!v }))}>
          隐藏状态查询
        </DropdownMenuCheckboxItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )

  return (
    <div ref={wrapRef} className="flex min-h-0 flex-col gap-3" style={height ? { height } : undefined}>
      {!connected ? (
        <div className="flex items-center gap-3 rounded-lg bg-fill px-3 py-2" role="status">
          <PlugZap className="size-4 shrink-0 text-secondary-label" aria-hidden />
          <p className="min-w-0 flex-1 text-callout text-secondary-label">
            {conn !== 'open' ? '与设备的连接已断开，控制台只读。' : '机器未连接，控制台只读。'}
          </p>
          <Button size="sm" variant="tinted" onClick={() => navigate('/machine')}>
            前往控制
          </Button>
        </div>
      ) : null}

      {/* filter bar */}
      <div className="flex items-center gap-2">
        <SearchField value={q} onValueChange={setQ} placeholder="过滤日志" className="min-w-0 flex-1 md:max-w-64" aria-label="过滤日志" />
        {compact ? (
          filterMenu
        ) : (
          <>
            <Segmented
              size="sm"
              aria-label="方向"
              value={prefs.dir}
              onValueChange={(v) => setPrefs((p) => ({ ...p, dir: v }))}
              options={[
                { value: 'all', label: '全部' },
                { value: '>', label: '发送' },
                { value: '<', label: '接收' },
                { value: '!', label: '事件' },
              ]}
            />
            <label className="flex items-center gap-2 text-callout text-secondary-label">
              <Switch checked={prefs.hideStatus} onCheckedChange={(v) => setPrefs((p) => ({ ...p, hideStatus: v }))} aria-label="隐藏状态查询" />
              隐藏状态查询
            </label>
          </>
        )}
        <div className="ml-auto flex items-center gap-0.5">
          <IconButton label={follow ? '暂停自动滚动' : '恢复自动滚动'} active={!follow} onClick={() => setFollow((f) => !f)}>
            {follow ? <Pause /> : <Play />}
          </IconButton>
          <IconButton label="导出日志" onClick={exportLog} disabled={!log.length}>
            <Download />
          </IconButton>
          <IconButton label="清空" onClick={clearLog} disabled={!log.length}>
            <Trash2 />
          </IconButton>
        </div>
      </div>

      {/* log */}
      <div className="relative min-h-0 flex-1 overflow-hidden rounded-lg bg-bg-grouped-secondary shadow-sm">
        <VirtualList
          ref={listRef}
          role="log"
          aria-label="串口日志"
          aria-live="off"
          tabIndex={0}
          className="focus-ring h-full py-1"
          count={lines.length}
          rowHeight={ROW_H}
          follow={follow}
          onAtBottomChange={setAtBottom}
          renderRow={(i) => <LogRow line={lines[i]} q={q.trim()} ms={!compact} />}
          empty={
            <div className="flex h-full flex-col items-center justify-center gap-1 px-6 text-center">
              <p className="text-headline text-secondary-label">{log.length ? '没有匹配的日志' : '暂无串口日志'}</p>
              <p className="text-footnote text-secondary-label">
                {log.length ? '调整筛选条件或清除搜索。' : connected ? '发送命令或开始任务后，收发记录会显示在这里。' : '连接机器后显示收发记录。'}
              </p>
            </div>
          }
        />
        {dropped > 0 ? (
          <span className="absolute right-3 top-2 rounded-full bg-orange/15 px-2 py-0.5 text-caption text-on-tint-orange">
            已丢弃 {dropped} 行
          </span>
        ) : null}
        {!atBottom && lines.length ? (
          <button
            type="button"
            onClick={() => {
              listRef.current?.scrollToBottom()
              setFollow(true)
            }}
            className="press focus-ring absolute bottom-3 left-1/2 inline-flex -translate-x-1/2 items-center gap-1 rounded-full bg-accent px-3 py-1 text-footnote font-medium text-white shadow-md animate-pop-in"
          >
            <ArrowDown className="size-3.5" /> 跳到最新
          </button>
        ) : null}
      </div>

      <CommandBar connected={connected} jobActive={jobActive} compact={compact} leaseBlock={leaseBlock} />
    </div>
  )
}

const QUICK_CMDS: { line: string; label: string; hint: string }[] = [
  { line: '$$', label: '$$', hint: '读取全部设置' },
  { line: '$X', label: '$X 解锁', hint: '解除报警锁定' },
  { line: '$G', label: '$G', hint: '查看模态状态' },
  { line: '$#', label: '$#', hint: '查看坐标偏移' },
  { line: '$I', label: '$I', hint: '固件构建信息' },
]

const RT_CMDS: { byte: RealtimeByte; label: string; hint: string; danger?: boolean }[] = [
  { byte: REALTIME.status, label: '? 状态', hint: '实时状态查询' },
  { byte: REALTIME.hold, label: '! 保持', hint: '进给保持（立即减速停止）' },
  { byte: REALTIME.resume, label: '~ 继续', hint: '从保持中继续' },
  { byte: REALTIME.jogCancel, label: '取消点动', hint: '0x85 Jog Cancel' },
  { byte: REALTIME.reset, label: '⌃X 软复位', hint: '0x18 软复位：清空缓冲区', danger: true },
]

function CommandBar({ connected, jobActive, compact, leaseBlock }: { connected: boolean; jobActive: boolean; compact: boolean; leaseBlock: string | null }) {
  const [value, setValue] = React.useState('')
  const [history, setHistory] = React.useState(loadHistory)
  const [hIdx, setHIdx] = React.useState<number | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<{ text: string; tone: 'red' | 'orange'; technical?: string } | null>(null)
  const [reply, setReply] = React.useState<{ line: string; lines: string[]; ok: boolean } | null>(null)
  const inputRef = React.useRef<HTMLInputElement>(null)
  const canSend = connected && !jobActive && !leaseBlock

  const pushHistory = (line: string) => {
    setHistory((h) => {
      const next = [...h.filter((x) => x !== line), line].slice(-50)
      localStorage.setItem(HISTORY_KEY, JSON.stringify(next))
      return next
    })
    setHIdx(null)
  }

  const send = async (raw: string) => {
    const line = raw.trim()
    if (!line || busy) return
    if (line === '\x18' || /^ctrl\+?x$/i.test(line)) return void rt(RT_CMDS[4])
    setBusy(true)
    setError(null)
    pushHistory(line)
    try {
      const r = await sendCommand(line)
      setReply({ line, lines: r.reply_lines ?? [], ok: r.ok })
      if (raw === value) setValue('')
    } catch (e) {
      const d = describeError(e)
      const timeout = e instanceof ApiError && (e.code === 'timeout' || e.status === 504)
      setError({
        text: timeout ? '写字机 10 秒内没有应答。检查 USB 线，或发送 ? 查看状态。' : d.hint ? `${d.title}。${d.hint}` : d.title,
        tone: timeout ? 'orange' : 'red',
        technical: d.technical,
      })
    } finally {
      setBusy(false)
      inputRef.current?.focus()
    }
  }

  const rt = async (c: (typeof RT_CMDS)[number]) => {
    if (c.danger) {
      const ok = await confirm({
        title: '发送软复位？',
        description: '控制器将立即复位并清空缓冲区。运动中复位会丢失坐标（ALARM:3），需要重新设原点。',
        confirmLabel: '软复位',
        destructive: true,
      })
      if (!ok) return
    }
    try {
      await sendRealtime(c.byte)
    } catch (e) {
      const d = describeError(e)
      toast.error(`${c.label} 没有发出：${d.title}`, { description: d.hint, key: 'console-rt' })
    }
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      void send(value)
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      if (!history.length) return
      e.preventDefault()
      const cur = hIdx ?? history.length
      const next = e.key === 'ArrowUp' ? Math.max(0, cur - 1) : cur + 1
      if (next >= history.length) {
        setHIdx(null)
        setValue('')
      } else {
        setHIdx(next)
        setValue(history[next])
      }
    } else if (e.key === 'Escape' && value) {
      e.stopPropagation()
      setValue('')
      setHIdx(null)
    }
  }

  const reason = !connected ? '机器未连接' : leaseBlock ? `${leaseBlock}，控制台只读` : jobActive ? '任务进行中：仅可发送实时命令（? ! ~）' : null

  return (
    <div className="flex flex-col gap-2">
      <div className="scrollbar-none -mx-4 flex items-center gap-1.5 overflow-x-auto px-4 md:mx-0 md:flex-wrap md:px-0" role="toolbar" aria-label="快捷命令">
        {RT_CMDS.map((c) => (
          <Tooltip key={c.byte} content={c.hint}>
            <Button
              size="sm"
              variant={c.danger ? 'destructive-tinted' : 'tinted'}
              className="shrink-0 font-mono pointer-coarse:h-11"
              disabled={!connected || !!leaseBlock}
              onClick={() => void rt(c)}
            >
              {c.label}
            </Button>
          </Tooltip>
        ))}
        <span className="mx-1 h-4 w-px shrink-0 bg-separator" aria-hidden />
        {QUICK_CMDS.map((c) => (
          <Tooltip key={c.line} content={c.hint}>
            <Button size="sm" variant="gray" className="shrink-0 font-mono pointer-coarse:h-11" disabled={!canSend || busy} onClick={() => void send(c.line)}>
              {c.label}
            </Button>
          </Tooltip>
        ))}
      </div>

      {reply ? (
        <div className="flex items-start gap-2 rounded-md bg-quaternary-fill px-3 py-1.5 font-mono text-footnote" aria-live="polite">
          <span className="shrink-0 text-accent">{reply.line}</span>
          <span className={cn('min-w-0 flex-1 truncate', reply.ok ? 'text-secondary-label' : 'text-red')}>
            {reply.lines.length ? reply.lines.join(' · ') : reply.ok ? 'ok' : '无回复'}
          </span>
          <button type="button" className="-my-1 flex size-6 shrink-0 items-center justify-center text-secondary-label hover:text-label pointer-coarse:size-11" aria-label="关闭回复" onClick={() => setReply(null)}>
            ×
          </button>
        </div>
      ) : null}

      <form
        className="flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          void send(value)
        }}
      >
        <div className="relative min-w-0 flex-1">
          <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 font-mono text-footnote text-tertiary-label" aria-hidden>
            &gt;
          </span>
          <input
            ref={inputRef}
            value={value}
            onChange={(e) => {
              setValue(e.currentTarget.value)
              setHIdx(null)
              setError(null)
            }}
            onKeyDown={onKeyDown}
            disabled={!canSend}
            placeholder={reason ?? (compact ? '输入命令' : '输入 G 代码或 $ 命令，回车发送')}
            aria-label="命令"
            aria-invalid={error?.tone === 'red' || undefined}
            aria-describedby="console-cmd-msg"
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            className={cn(
              'h-8 w-full rounded-md bg-bg-elevated pl-7 pr-2 font-mono text-callout text-label placeholder:font-sans placeholder:text-tertiary-label pointer-coarse:h-11',
              'shadow-[inset_0_0_0_0.5px_rgb(var(--separator)/var(--separator-a))] outline-none focus:shadow-[inset_0_0_0_1px_rgb(var(--accent)),0_0_0_3px_rgb(var(--accent)/0.3)]',
              'disabled:opacity-60',
            )}
          />
        </div>
        <Button type="submit" variant="filled" disabled={!canSend || !value.trim()} loading={busy} icon={busy ? undefined : <CornerDownLeft />} className="h-8 pointer-coarse:h-11">
          发送
        </Button>
      </form>
      <p id="console-cmd-msg" className={cn('-mt-1 min-h-4 text-footnote', error ? (error.tone === 'red' ? 'text-red' : 'text-on-tint-orange') : 'text-secondary-label')} role={error ? 'alert' : undefined}>
        {busy ? (
          <span className="inline-flex items-center gap-1.5">
            <Spinner size={11} /> 等待回复…
          </span>
        ) : error ? (
          <span title={error.technical ? `技术详情：${error.technical}` : undefined}>{error.text}</span>
        ) : reason && connected ? (
          reason
        ) : (
          <span className="hidden md:inline">↑ ↓ 浏览历史 · 打印中禁止发送非实时命令</span>
        )}
      </p>
    </div>
  )
}
