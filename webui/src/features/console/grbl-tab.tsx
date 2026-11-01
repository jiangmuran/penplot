import { Download, History, PlugZap, RefreshCw, ShieldAlert, TriangleAlert, Upload } from 'lucide-react'
import * as React from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useShallow } from 'zustand/react/shallow'
import { isApiError } from '@/api/client'
import { describeError } from '@/api/errors'
import { useLease, useRole } from '@/api/collab'
import { pickFile, saveText } from '@/api/download'
import { refreshGrblSettings, useGrblSettings, writeGrblSettings, type GrblSetting } from '@/api/grbl'
import { isJobActive, useLive } from '@/api/store'
import {
  Button, Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, EmptyState, ErrorState,
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger, IconButton, Input, SearchField, Skeleton, Switch,
  Textarea,
} from '@/components/ui'
import { cn } from '@/lib/cn'
import { useIsCompact } from '@/lib/media'
import { toast } from '@/lib/toast'
import { formatRelative } from '@/lib/format'
import { grblChangeRisk, grblSettingMeta } from './grbl-codes'

type Edits = Record<number, string>

function validate(v: string, type: string): boolean {
  const t = v.trim()
  if (t === '') return false
  if (type === 'bool') return t === '0' || t === '1'
  if (type === 'int' || type === 'mask') return /^\d+$/.test(t) && Number(t) <= 65535
  return Number.isFinite(Number(t))
}

/** Parse `$n=v` lines (from `$$` output). */
export function parseDollarLines(text: string): Record<number, string> {
  const out: Record<number, string> = {}
  for (const raw of text.split(/\r?\n/)) {
    const m = /^\s*\$(\d+)\s*=\s*([-+0-9.]+)/.exec(raw)
    if (m) out[Number(m[1])] = m[2]
  }
  return out
}

// ---- automatic `$$` backups before every write (05-review §3.3) ----
const BACKUP_KEY = 'penplot.grbl.backups'
export interface GrblBackup {
  ts: number
  values: Record<number, string>
}
export function loadBackups(): GrblBackup[] {
  try {
    const v = JSON.parse(localStorage.getItem(BACKUP_KEY) ?? '[]')
    return Array.isArray(v) ? v.filter((b) => b && typeof b.ts === 'number' && b.values) : []
  } catch {
    return []
  }
}
function saveBackup(rows: GrblSetting[]): GrblBackup {
  const b: GrblBackup = { ts: Date.now(), values: Object.fromEntries(rows.map((r) => [r.n, r.value])) }
  try {
    localStorage.setItem(BACKUP_KEY, JSON.stringify([b, ...loadBackups()].slice(0, 5)))
  } catch {
    /* storage full / private mode: write still proceeds */
  }
  return b
}

function sameValue(a: string, b: string) {
  const na = Number(a)
  const nb = Number(b)
  return Number.isFinite(na) && Number.isFinite(nb) ? na === nb : a.trim() === b.trim()
}

export function GrblTab() {
  const navigate = useNavigate()
  const compact = useIsCompact()
  const { machine, job, conn } = useLive(useShallow((s) => ({ machine: s.machine, job: s.job, conn: s.conn })))
  const connected = conn === 'open' && !!machine?.connected
  const jobActive = isJobActive(job) || !!machine?.busy
  const q = useGrblSettings(connected)
  const [filter, setFilter] = React.useState('')
  const [edits, setEdits] = React.useState<Edits>({})
  const [refreshing, setRefreshing] = React.useState(false)
  const [importOpen, setImportOpen] = React.useState(false)
  const [diffOpen, setDiffOpen] = React.useState(false)
  const [backups, setBackups] = React.useState(loadBackups)
  const [params, setParams] = useSearchParams()

  const rows = React.useMemo(() => [...(q.data ?? [])].sort((a, b) => a.n - b.n), [q.data])
  const byN = React.useMemo(() => new Map(rows.map((r) => [r.n, r])), [rows])
  const changed = rows.filter((r) => edits[r.n] != null && !sameValue(edits[r.n], r.value))
  const invalid = changed.filter((r) => !validate(edits[r.n], grblSettingMeta(r.n).type))
  const role = useRole()
  const lease = useLease()
  const lockReason = role !== 'admin'
    ? '只有管理员可以修改 GRBL 设置，当前为只读。'
    : !lease.canControl
      ? `控制权在 ${lease.holderName ?? '其他用户'} 手中，设置为只读。`
      : jobActive
        ? '任务进行中，设置为只读。任务结束后才能写入 EEPROM。'
        : null
  const readOnly = !connected || !!lockReason

  // `?set=22:0` (from the code reference, e.g. ALARM:9 → 去关闭 $22) stages an edit once the table is loaded.
  React.useEffect(() => {
    const raw = params.get('set')
    if (!raw || !rows.length) return
    const staged: Edits = {}
    for (const part of raw.split(',')) {
      const m = /^\$?(\d+)[:=]([-0-9.]+)$/.exec(part.trim())
      if (m && byN.has(Number(m[1]))) staged[Number(m[1])] = m[2]
    }
    if (Object.keys(staged).length) {
      setEdits((e) => ({ ...e, ...staged }))
      setFilter('')
      toast.info('已暂存修改', { description: '检查后点击「写入机器…」。' })
    }
    const next = new URLSearchParams(params)
    next.delete('set')
    setParams(next, { replace: true })
  }, [params, rows.length, byN, setParams])

  const restoreBackup = (b: GrblBackup) => {
    const staged: Edits = {}
    for (const [k, v] of Object.entries(b.values)) {
      const r = byN.get(Number(k))
      if (r && !sameValue(v, r.value)) staged[r.n] = v
    }
    const n = Object.keys(staged).length
    setEdits(staged)
    if (n) toast.info(`已暂存 ${n} 项恢复`, { description: '检查后点击「写入机器…」把它们写回控制板。' })
    else toast.info('当前参数与该备份相同')
  }

  const visible = React.useMemo(() => {
    const f = filter.trim().toLowerCase()
    if (!f) return rows
    return rows.filter((r) => {
      const m = grblSettingMeta(r.n)
      return `$${r.n} ${m.name} ${m.desc} ${r.desc} ${m.unit}`.toLowerCase().includes(f)
    })
  }, [rows, filter])

  const setEdit = (n: number, v: string) => setEdits((e) => ({ ...e, [n]: v }))

  const doRefresh = async () => {
    setRefreshing(true)
    try {
      await refreshGrblSettings()
    } catch (e) {
      const d = describeError(e)
      toast.error(`读取 GRBL 参数失败：${d.title}`, { description: d.hint, key: 'grbl-refresh' })
    } finally {
      setRefreshing(false)
    }
  }

  const doExport = () => {
    const text = rows.map((r) => `$${r.n}=${r.value}`).join('\n') + '\n'
    saveText(text, `grbl-settings-${new Date().toISOString().slice(0, 10)}.txt`)
  }

  const applyImport = (parsed: Record<number, string>) => {
    const next: Edits = { ...edits }
    let n = 0
    let unknown = 0
    for (const [k, v] of Object.entries(parsed)) {
      const r = byN.get(Number(k))
      if (!r) {
        unknown++
        continue
      }
      if (!sameValue(v, r.value)) {
        next[r.n] = v
        n++
      }
    }
    setEdits(next)
    setImportOpen(false)
    if (n) toast.info(`已暂存 ${n} 项修改`, { description: unknown ? `${unknown} 项在当前固件中不存在，已忽略。` : '检查后点击「写入机器…」。' })
    else toast.info('导入的设置与当前值相同')
  }

  if (!connected) {
    return (
      <EmptyState
        icon={PlugZap}
        title="机器未连接"
        description="连接机器后才能读取和修改 GRBL $$ 设置。"
        action={
          <Button variant="filled" onClick={() => navigate('/machine')}>
            前往控制
          </Button>
        }
      />
    )
  }

  return (
    <div className="flex flex-col gap-3 pb-20">
      {lockReason ? (
        <div className="flex items-center gap-2 rounded-lg bg-orange/15 px-3 py-2 text-callout text-on-tint-orange" role="status">
          <TriangleAlert className="size-4 shrink-0" aria-hidden /> {lockReason}
        </div>
      ) : null}

      <div className="flex items-center gap-2">
        <SearchField value={filter} onValueChange={setFilter} placeholder="搜索 $编号 或名称" className="min-w-0 flex-1 md:max-w-72" aria-label="搜索设置" />
        <div className="ml-auto flex items-center gap-0.5">
          <IconButton label="从控制器重新读取" onClick={() => void doRefresh()} loading={refreshing} disabled={jobActive}>
            <RefreshCw />
          </IconButton>
          <IconButton label="导入 $$…" onClick={() => setImportOpen(true)} disabled={readOnly || !rows.length}>
            <Upload />
          </IconButton>
          <IconButton label="导出 $$" onClick={doExport} disabled={!rows.length}>
            <Download />
          </IconButton>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <IconButton label="写入前的备份" disabled={!backups.length || !rows.length}>
                <History />
              </IconButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>恢复写入前的参数（暂存后需再次写入）</DropdownMenuLabel>
              {backups.map((b) => (
                <DropdownMenuItem key={b.ts} onSelect={() => restoreBackup(b)} disabled={readOnly}>
                  {new Date(b.ts).toLocaleString('zh-CN', { hour12: false })} · {formatRelative(b.ts)}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {q.isPending ? (
        <SettingsSkeleton />
      ) : q.isError ? (
        <ErrorState
          title={isApiError(q.error) && q.error.status === 503 ? '机器未连接' : '无法读取 GRBL 设置'}
          error={q.error}
          onRetry={() => void q.refetch()}
        />
      ) : !rows.length ? (
        <EmptyState title="没有设置项" description="控制器没有返回 $$ 设置。" action={<Button onClick={() => void doRefresh()}>重新读取</Button>} />
      ) : !visible.length ? (
        <EmptyState title="没有匹配的设置" description="换个关键词试试。" />
      ) : (
        <div className="overflow-hidden rounded-lg bg-bg-grouped-secondary shadow-sm">
          {!compact ? (
            <div className="hairline-b grid grid-cols-[64px_minmax(140px,1fr)_160px_80px_minmax(200px,2fr)] items-center gap-3 px-4 py-2 text-footnote font-medium text-secondary-label" role="row">
              <span>编号</span>
              <span>名称</span>
              <span className="text-right">值</span>
              <span>单位</span>
              <span>说明</span>
            </div>
          ) : null}
          <div role="table" aria-label="GRBL 设置" className="[&>*+*]:hairline-t">
            {visible.map((r) => (
              <SettingRow
                key={r.n}
                row={r}
                compact={compact}
                value={edits[r.n] ?? r.value}
                changed={edits[r.n] != null && !sameValue(edits[r.n], r.value)}
                risk={grblChangeRisk(r.n, r.value, (edits[r.n] ?? r.value).trim())}
                disabled={readOnly}
                onChange={(v) => setEdit(r.n, v)}
                onReset={() =>
                  setEdits((e) => {
                    const { [r.n]: _drop, ...rest } = e
                    void _drop
                    return rest
                  })
                }
              />
            ))}
          </div>
        </div>
      )}

      {changed.length ? (
        <div className="sticky bottom-3 z-10 mx-auto flex w-full max-w-xl items-center gap-3 rounded-xl px-4 py-2.5 shadow-lg mat-thick animate-pop-in" role="region" aria-label="未写入的修改">
          <span className="size-2 shrink-0 rounded-full bg-orange" aria-hidden />
          <span className="min-w-0 flex-1 text-callout text-label">
            已修改 {changed.length} 项{invalid.length ? <span className="text-red">（{invalid.length} 项无效）</span> : null}
          </span>
          <Button variant="gray" onClick={() => setEdits({})}>
            还原
          </Button>
          <Button variant="filled" disabled={readOnly || invalid.length > 0} onClick={() => setDiffOpen(true)}>
            写入机器…
          </Button>
        </div>
      ) : null}

      <ImportDialog open={importOpen} onOpenChange={setImportOpen} onApply={applyImport} />
      <DiffDialog
        open={diffOpen}
        onOpenChange={setDiffOpen}
        rows={changed.map((r) => ({ n: r.n, from: r.value, to: edits[r.n].trim() }))}
        onBeforeWrite={() => {
          const b = saveBackup(rows)
          setBackups(loadBackups())
          return b
        }}
        onDone={(b) => {
          setEdits({})
          toast({
            title: `已写入 ${changed.length} 项设置`,
            description: '写入前的参数已自动备份。',
            level: 'success',
            duration: 10_000,
            action: { label: '恢复写入前', onClick: () => restoreBackup(b) },
          })
        }}
      />
    </div>
  )
}

function SettingsSkeleton() {
  return (
    <div role="status" aria-label="加载中" className="overflow-hidden rounded-lg bg-bg-grouped-secondary shadow-sm">
      {Array.from({ length: 10 }, (_, i) => (
        <div key={i} className="flex h-11 items-center gap-4 px-4 [&+&]:hairline-t">
          <Skeleton className="h-3 w-10" />
          <Skeleton className="h-3 flex-1" style={{ maxWidth: `${30 + ((i * 17) % 30)}%` }} />
          <Skeleton className="ml-auto h-6 w-24" />
        </div>
      ))}
    </div>
  )
}

function RiskNote({ risk, changed }: { risk: ReturnType<typeof grblChangeRisk>; changed: boolean }) {
  if (!risk || (risk.level === 'caution' && !changed)) return null
  const danger = risk.level === 'danger'
  return (
    <p className={cn('mt-0.5 flex items-start gap-1 text-footnote', danger ? 'font-medium text-red' : 'text-on-tint-orange')}>
      {danger ? <ShieldAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden /> : <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />}
      {risk.text}
    </p>
  )
}

function SettingRow({
  row, value, changed, disabled, compact, onChange, onReset, risk,
}: {
  row: GrblSetting
  value: string
  changed: boolean
  risk: ReturnType<typeof grblChangeRisk>
  disabled: boolean
  compact: boolean
  onChange: (v: string) => void
  onReset: () => void
}) {
  const meta = grblSettingMeta(row.n)
  const desc = meta.desc || row.desc
  const unit = meta.unit || row.unit
  const valid = validate(value, meta.type)
  const id = `grbl-${row.n}`
  const control =
    meta.type === 'bool' ? (
      <Switch id={id} checked={value.trim() === '1'} disabled={disabled} onCheckedChange={(v) => onChange(v ? '1' : '0')} aria-label={`$${row.n} ${meta.name}`} />
    ) : (
      <input
        id={id}
        value={value}
        disabled={disabled}
        inputMode="decimal"
        aria-label={`$${row.n} ${meta.name}`}
        aria-invalid={!valid || undefined}
        onChange={(e) => onChange(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onReset()
        }}
        className={cn(
          compact ? 'w-28' : 'w-full max-w-36',
          'h-7 rounded-sm bg-bg-elevated px-2 text-right font-mono text-callout tabular-nums text-label outline-none pointer-coarse:h-10',
          'shadow-[inset_0_0_0_0.5px_rgb(var(--separator)/var(--separator-a))] focus:shadow-[inset_0_0_0_1px_rgb(var(--accent)),0_0_0_3px_rgb(var(--accent)/0.3)]',
          'aria-[invalid=true]:shadow-[inset_0_0_0_1px_rgb(var(--red))] disabled:opacity-60',
        )}
      />
    )
  const danger = risk?.level === 'danger'
  const bar = danger
    ? 'shadow-[inset_3px_0_0_rgb(var(--red))] bg-red/[0.06]'
    : changed
      ? 'shadow-[inset_3px_0_0_rgb(var(--orange))] bg-orange/[0.06]'
      : ''
  const title = (
    <span className="flex min-w-0 items-center gap-1.5">
      <span className="truncate text-body text-label">{meta.name}</span>
      {meta.caution ? (
        <span title={meta.caution} className="shrink-0 text-orange">
          <TriangleAlert className="size-3.5" aria-label={meta.caution} />
        </span>
      ) : null}
    </span>
  )

  if (compact) {
    return (
      <div role="row" className={cn('flex flex-col gap-1 px-4 py-2.5', bar)}>
        <div className="flex items-center gap-3">
          <label htmlFor={id} className="flex min-w-0 flex-1 items-baseline gap-2">
            <span className="shrink-0 font-mono text-footnote text-secondary-label">${row.n}</span>
            {title}
          </label>
          <div className="flex shrink-0 items-center gap-1.5">
            {control}
            {unit && meta.type !== 'bool' ? <span className="w-12 text-footnote text-secondary-label">{unit}</span> : null}
          </div>
        </div>
        {desc ? <p className="text-footnote text-secondary-label">{desc}</p> : null}
        <RiskNote risk={risk} changed={changed} />
        {changed ? (
          <p className="text-footnote text-on-tint-orange">
            原值 <span className="font-mono">{row.value}</span>
          </p>
        ) : null}
      </div>
    )
  }

  return (
    <div role="row" className={cn('grid min-h-11 grid-cols-[64px_minmax(140px,1fr)_160px_80px_minmax(200px,2fr)] items-center gap-3 px-4 py-1.5', bar)}>
      <label htmlFor={id} className="font-mono text-callout text-secondary-label" role="cell">
        ${row.n}
      </label>
      <div role="cell" className="min-w-0 py-1">
        {title}
        {changed ? (
          <span className="text-footnote text-on-tint-orange">
            原值 <span className="font-mono">{row.value}</span>
          </span>
        ) : null}
        <RiskNote risk={risk} changed={changed} />
      </div>
      <div role="cell" className="flex justify-end">
        {control}
      </div>
      <span role="cell" className="text-footnote text-secondary-label">
        {unit}
      </span>
      <span role="cell" className="text-footnote text-secondary-label">
        {desc}
      </span>
    </div>
  )
}

function ImportDialog({ open, onOpenChange, onApply }: { open: boolean; onOpenChange: (o: boolean) => void; onApply: (p: Record<number, string>) => void }) {
  const [text, setText] = React.useState('')
  React.useEffect(() => {
    if (!open) setText('')
  }, [open])
  const parsed = parseDollarLines(text)
  const count = Object.keys(parsed).length
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>导入 $$ 设置</DialogTitle>
          <DialogDescription>粘贴 `$n=值` 格式的设置（例如之前导出的备份）。导入只会暂存修改，确认后才写入机器。</DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-2">
          <Textarea
            value={text}
            onChange={(e) => setText(e.currentTarget.value)}
            placeholder={'$100=80.000\n$110=3000.000\n…'}
            className="min-h-48 font-mono text-footnote"
            aria-label="设置文本"
            spellCheck={false}
          />
          <div className="flex items-center justify-between">
            <Button
              size="sm"
              variant="plain"
              icon={<Upload />}
              onClick={async () => {
                const f = await pickFile('.txt,.nc,.gcode,text/plain')
                if (f) setText(await f.text())
              }}
            >
              从文件读取…
            </Button>
            <span className="text-footnote text-secondary-label">识别到 {count} 项</span>
          </div>
        </DialogBody>
        <DialogFooter>
          <Button onClick={() => onOpenChange(false)}>取消</Button>
          <Button variant="filled" disabled={!count} onClick={() => onApply(parsed)}>
            暂存修改
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

const CONFIRM_WORD = '确认'

function DiffDialog({
  open, onOpenChange, rows, onBeforeWrite, onDone,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  rows: { n: number; from: string; to: string }[]
  onBeforeWrite: () => GrblBackup
  onDone: (backup: GrblBackup) => void
}) {
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState<ReturnType<typeof describeError> | null>(null)
  const [word, setWord] = React.useState('')
  React.useEffect(() => {
    if (open) {
      setError(null)
      setWord('')
    }
  }, [open])
  const risks = rows.map((r) => ({ r, risk: grblChangeRisk(r.n, r.from, r.to) }))
  const dangerous = risks.some((x) => x.risk?.level === 'danger')
  const confirmed = !dangerous || word.trim() === CONFIRM_WORD
  const write = async () => {
    if (!confirmed) return
    setSaving(true)
    setError(null)
    try {
      const backup = onBeforeWrite()
      const body: Record<string, number | string> = {}
      for (const r of rows) body[String(r.n)] = Number.isFinite(Number(r.to)) ? Number(r.to) : r.to
      await writeGrblSettings(body)
      onDone(backup)
      onOpenChange(false)
    } catch (e) {
      setError(describeError(e))
    } finally {
      setSaving(false)
    }
  }
  return (
    <Dialog open={open} onOpenChange={(o) => !saving && onOpenChange(o)}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>写入 {rows.length} 项设置到机器？</DialogTitle>
          <DialogDescription>新值会保存到控制板 EEPROM，立即生效。写入前会自动备份当前全部参数，之后可以一键恢复。</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <ul className="overflow-hidden rounded-lg bg-quaternary-fill [&>*+*]:hairline-t">
            {risks.map(({ r, risk }) => (
              <li key={r.n} className={cn('px-3 py-2', risk?.level === 'danger' && 'bg-red/10')}>
                <div className="flex items-center gap-2 text-callout">
                  <span className="w-12 shrink-0 font-mono text-secondary-label">${r.n}</span>
                  <span className="min-w-0 flex-1 truncate">{grblSettingMeta(r.n).name}</span>
                  <span className="font-mono tabular-nums text-secondary-label line-through">{r.from}</span>
                  <span className="text-secondary-label" aria-label="改为">→</span>
                  <span className={cn('font-mono font-semibold tabular-nums', risk?.level === 'danger' ? 'text-red' : 'text-on-tint-orange')}>{r.to}</span>
                </div>
                {risk ? (
                  <p className={cn('mt-1 flex items-start gap-1 text-footnote', risk.level === 'danger' ? 'font-medium text-red' : 'text-on-tint-orange')}>
                    {risk.level === 'danger' ? <ShieldAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden /> : <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />}
                    {risk.text}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
          {dangerous ? (
            <div className="mt-3 flex flex-col gap-1.5">
              <label htmlFor="grbl-confirm-word" className="text-footnote text-secondary-label">
                包含危险修改。如果确定要写入，请输入「{CONFIRM_WORD}」：
              </label>
              <Input
                id="grbl-confirm-word"
                value={word}
                onChange={(e) => setWord(e.currentTarget.value)}
                placeholder={CONFIRM_WORD}
                autoComplete="off"
                invalid={word.length > 0 && !confirmed}
              />
            </div>
          ) : null}
          {error ? (
            <div role="alert" className="mt-2 text-footnote text-red">
              <p className="font-medium">写入失败：{error.title}</p>
              {error.hint ? <p className="text-secondary-label">{error.hint}</p> : null}
              {error.technical ? (
                <details className="mt-1 text-secondary-label">
                  <summary className="cursor-pointer">技术详情</summary>
                  <code className="break-all font-mono">{error.technical}</code>
                </details>
              ) : null}
            </div>
          ) : null}
        </DialogBody>
        <DialogFooter>
          <Button autoFocus onClick={() => onOpenChange(false)} disabled={saving}>
            取消
          </Button>
          <Button variant="destructive-tinted" loading={saving} disabled={!confirmed} onClick={() => void write()}>
            写入
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
