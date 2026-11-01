/**
 * 打印 Sheet (02-ux §3.3 + 05-review §1.2-8/9): verdict "放得下吗" (paper / travel ✓✕), time + finish clock,
 * missing glyphs, frame step, machine-config defaults with per-field override dots, copies, pages, start/end G-code.
 * Starting is blocked when the drawing leaves the machine travel (admin can explicitly override).
 */
import { useQuery } from '@tanstack/react-query'
import { Check, CircleCheck, CircleX, Crosshair, Download, Plug, RotateCcw, TriangleAlert } from 'lucide-react'
import * as React from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '@/api/client'
import { connectMachine } from '@/api/machine'
import { qk } from '@/api/query'
import { useLive } from '@/api/store'
import type { AuthState } from '@/api/types'
import { exportRender, type PaperBase, type PrintOverrides, type RenderResult } from '@/api/studio'
import { Button, Dialog, DialogContent, DialogTitle, NumberField, ProgressBar, Segmented, Select, Spinner, Switch, Textarea } from '@/components/ui'
import { cn } from '@/lib/cn'
import { confirm } from '@/lib/confirm'
import { formatDurationSpoken } from '@/lib/format'
import { useIsCompact } from '@/lib/media'
import { toast } from '@/lib/toast'
import { useProfiles } from '../data'
import { errText, Help } from '../ext'
import { hasTravel, originAnchor, originPoint, paperDims, workAreaRect, type ContentBox } from '../model'
import type { PageBackground } from '../background'
import { BackgroundImage } from '../canvas/background-layer'
import { originSnapLines, originSnapPoints, parkText as parkWhere, useSvgOriginDrag } from '../origin-drag'
import { createJobs, profileDefault, renderForOutput, runFrame, type FrameMode, type OverrideKey } from '../print'
import { useStudio } from '../store'
import type { OriginSpec } from '@/api/studio'

export function finishClock(sec: number) {
  const d = new Date(Date.now() + sec * 1000)
  const sameDay = d.toDateString() === new Date().toDateString()
  const hm = d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
  return sameDay ? hm : `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`
}

function parseRange(s: string, max: number): number[] {
  const out = new Set<number>()
  for (const part of s.split(/[,，\s]+/)) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part.trim())
    if (!m) continue
    const a = Number(m[1])
    const b = m[2] ? Number(m[2]) : a
    for (let i = Math.min(a, b); i <= Math.max(a, b); i++) if (i >= 1 && i <= max) out.add(i - 1)
  }
  return [...out].sort((x, y) => x - y)
}

export function PrintSheet({ open, onOpenChange, paper, origin, onOpenPosition }: { open: boolean; onOpenChange: (o: boolean) => void; paper: PaperBase; origin: OriginSpec; onOpenPosition: () => void }) {
  const compact = useIsCompact()
  const navigate = useNavigate()
  const profiles = useProfiles()
  const machine = useLive((s) => s.machine)
  const auth = useQuery({ queryKey: qk.auth.state, queryFn: () => api.get<AuthState>('/auth/state'), staleTime: 60_000 })
  const isAdmin = (auth.data?.scopes ?? ['admin']).includes('admin')
  const doc = useStudio((s) => s.doc)
  const project = useStudio((s) => s.project)
  const view = useStudio((s) => s.view)
  const placement = useStudio((s) => s.placement)
  const active = profiles.data?.find((p) => p.is_active) ?? profiles.data?.[0]
  const [profileId, setProfileId] = React.useState<string | null>(null)
  const profile = profiles.data?.find((p) => p.id === profileId) ?? active
  const [result, setResult] = React.useState<RenderResult | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [err, setErr] = React.useState<string | null>(null)
  // render progress (202 task → GET /tasks/{id}), elapsed time and manual retry/cancel
  const [prog, setProg] = React.useState<{ p: number; msg: string } | null>(null)
  const [busySince, setBusySince] = React.useState<number | null>(null)
  const [retryN, setRetryN] = React.useState(0)
  const ctlRef = React.useRef<AbortController | null>(null)
  const [, tick] = React.useReducer((x: number) => x + 1, 0)
  React.useEffect(() => {
    if (!busySince) return
    const t = setInterval(tick, 1000)
    return () => clearInterval(t)
  }, [busySince])
  const [range, setRange] = React.useState<'all' | 'current' | 'custom'>('all')
  const [custom, setCustom] = React.useState('1')
  const [ready, setReady] = React.useState(false)
  const [framed, setFramed] = React.useState(false)
  const [framing, setFraming] = React.useState(false)
  const [frameMode, setFrameMode] = React.useState<FrameMode>('up')
  const [starting, setStarting] = React.useState(false)
  const [advanced, setAdvanced] = React.useState(false)
  const pr = (doc?.print ?? {}) as PrintOverrides

  React.useEffect(() => {
    if (open) {
      setReady(false)
      setFramed(false)
      setProfileId(null)
    }
  }, [open])

  // (re)render while open
  const printKey = JSON.stringify([pr, profile?.id, placement, open])
  const version = useStudio((s) => s.version)
  React.useEffect(() => {
    if (!open || !profile) return
    const ctl = new AbortController()
    ctlRef.current = ctl
    const t = setTimeout(async () => {
      setBusy(true)
      setBusySince(Date.now())
      setProg(null)
      setErr(null)
      try {
        setResult(
          await renderForOutput({
            profileId: profile.id,
            signal: ctl.signal,
            onProgress: (tk) => setProg({ p: Math.round((tk.progress ?? 0) * 100), msg: tk.message ?? '' }),
          }),
        )
      } catch (e) {
        if (!ctl.signal.aborted) setErr(errText(e))
      } finally {
        if (!ctl.signal.aborted) {
          setBusy(false)
          setBusySince(null)
        }
      }
    }, result ? 500 : 0)
    return () => {
      clearTimeout(t)
      ctl.abort()
    }
  }, [printKey, version, retryN]) // eslint-disable-line react-hooks/exhaustive-deps
  const cancelRender = () => {
    ctlRef.current?.abort()
    setBusy(false)
    setBusySince(null)
    setErr('已取消计算')
  }
  const elapsed = busySince ? Math.floor((Date.now() - busySince) / 1000) : 0

  if (!doc || !project) return null
  const outs = result?.pages ?? []
  const selected =
    range === 'all' ? outs.map((p) => p.index) : range === 'current' ? outs.filter((p) => p.source_page === view.page).map((p) => p.index) : parseRange(custom, outs.length)
  const selPages = outs.filter((p) => selected.includes(p.index))
  const copies = Math.max(1, pr.copies ?? 1)
  const perCopy = selPages.reduce((n, p) => n + p.est_s, 0)
  const total = perCopy * (pr.copy_mode && pr.copy_mode !== 'repeat_same' ? 1 : copies)
  const missing = [...new Set(selPages.flatMap((p) => p.warnings.missing_glyphs))]
  const clipped = selPages.some((p) => p.warnings.clipped)
  const first = selPages[0]
  const bbox = first?.bbox
  const { w: pw, h: ph } = paperDims(paper)
  const wa = hasTravel(profile?.doc.work_area) ? profile!.doc.work_area! : null
  // travel is only a verdict when the profile has a travel area (0×0 = not configured, never blocks)
  const outWork = !!wa && selPages.some((p) => p.out_of_work_area)
  const cbox: ContentBox = bbox ? { x: bbox[0], y: bbox[1], w: bbox[2] - bbox[0], h: bbox[3] - bbox[1] } : null
  const cornerName = ['左上', '右上', '左下', '右下'][origin.corner]
  const parkLine = originAnchor(origin) === 'content' ? `开始前：把笔（抬起状态）停在要写内容的${cornerName}角` : `开始前：把笔（抬起状态）停在纸张${cornerName}角`
  const overriddenKeys = (Object.keys(pr) as (keyof PrintOverrides)[]).filter((k) => k !== 'origin' && pr[k] != null)
  const connected = !!machine?.connected
  const busyMachine = !!machine?.busy

  const setField = (k: OverrideKey, v: unknown) =>
    useStudio.getState().edit((d) => {
      d.print = { ...d.print, [k]: v }
    }, { coalesce: `print.${k}` })
  const resetAll = () =>
    useStudio.getState().edit((d) => {
      d.print = { origin: d.print?.origin ?? null }
    })
  const eff = <T,>(k: OverrideKey): T => (pr[k] ?? profileDefault(profile?.doc, k)) as T

  const doFrame = async () => {
    const mb = first?.machine_bbox
    if (!mb) return
    setFraming(true)
    const ok = await runFrame(mb, frameMode, eff<number>('jog_speed'))
    setFraming(false)
    if (ok) setFramed(true)
  }

  const start = async () => {
    // permission prompt must happen inside the click
    try {
      if ('Notification' in window && Notification.permission === 'default' && !localStorage.getItem('penplot.notifyAsked')) {
        localStorage.setItem('penplot.notifyAsked', '1')
        void Notification.requestPermission()
      }
    } catch {
      /* Safari without PWA */
    }
    if (!result || !selected.length) return
    if (outWork) {
      if (!isAdmin) return
      const ok = await confirm({ title: '超出行程仍要打印？', description: '有内容在机器够不到的地方，那部分会撞到行程极限或被跳过。只有确定行程设置有误时才这样做。', confirmLabel: '仍要打印', destructive: true })
      if (!ok) return
    }
    if (missing.length) {
      const ok = await confirm({ title: `有 ${missing.length} 个字会画成方框`, description: `当前字体缺：${missing.slice(0, 20).join('')}。仍要开始吗？`, confirmLabel: '仍要开始' })
      if (!ok) return
    }
    setStarting(true)
    try {
      const jobs = await createJobs({ result, pages: selected, name: project.name, profileId: profile?.id ?? null, overrides: copies > 1 ? { copies } : null, start: true, allowOutOfBounds: outWork && isAdmin, penUpConfirmed: ready })
      onOpenChange(false)
      const startedNow = jobs[0]?.status !== 'queued'
      toast.success(startedNow ? `已开始 · ${formatDurationSpoken(total)}` : `已加入队列（${jobs.length} 个任务）`, {
        description: jobs.length > 1 ? `共 ${jobs.length} 页，每页写完后等你换纸。` : undefined,
        action: { label: '查看进度', onClick: () => navigate('/jobs') },
      })
    } catch (e) {
      toast.error('无法开始打印', { description: errText(e) })
    } finally {
      setStarting(false)
    }
  }

  const blockReason = !connected ? '先连接写字机' : busyMachine ? '写字机正忙' : !result ? (busy ? '正在计算…' : '没有算出结果，请重试') : !selected.length ? '没有选中页面' : outWork && !isAdmin ? '内容超出机器行程' : !ready ? '请确认笔已抬起并停在起点' : null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="xl" onOpenAutoFocus={(e) => e.preventDefault()} className={cn(compact ? 'h-[100dvh] max-h-none w-screen max-w-none rounded-none' : 'h-[min(680px,calc(100dvh-32px))] max-w-[880px]')}>
        <div className="flex h-full min-h-0 flex-col">
          <div className="hairline-b flex shrink-0 items-center gap-3 px-5 py-3 pr-12">
            <DialogTitle>打印</DialogTitle>
            <span className="truncate text-footnote text-secondary-label">
              {project.name} · {outs.length || doc.pages.length} 页
            </span>
            {busy ? <Spinner size={14} /> : null}
          </div>
          <div className={cn('flex min-h-0 flex-1', compact ? 'flex-col overflow-y-auto' : '')}>
            {/* summary */}
            <aside className={cn('flex shrink-0 flex-col gap-3 p-4', compact ? '' : 'hairline-r w-[320px] overflow-y-auto')}>
              <FitPreview paper={paper} bbox={bbox ?? null} work={wa ? workAreaRect(origin, pw, ph, wa.w_mm, wa.h_mm, cbox) : null} outWork={outWork} origin={origin} content={cbox} bg={doc.pages[view.page]?.background ?? null} />
              <p className="-mt-1 flex items-start gap-1.5 text-footnote text-secondary-label">
                <span className="mt-1 size-2 shrink-0 rounded-full bg-axis-origin" aria-hidden />
                <span>
                  {parkLine}（{parkWhere(origin, pw, ph, cbox, true)}）。
                  <span className="block text-tertiary-label">拖动上图的原点可以改起点</span>
                </span>
              </p>
              <div className="flex flex-col gap-1.5 text-body">
                <Verdict ok={!clipped} label={clipped ? '有内容超出纸张' : '在纸张内'} detail={bbox ? `${(bbox[2] - bbox[0]).toFixed(0)} × ${(bbox[3] - bbox[1]).toFixed(0)} mm` : undefined} warn />
                {wa ? <Verdict ok={!outWork} label={outWork ? '超出机器行程' : '在机器行程内'} detail={`行程 ${wa.w_mm}×${wa.h_mm}`} /> : null}
                {connected ? (
                  <div className="flex items-center gap-2">
                    <Verdict ok={!!machine?.origin_valid} label={machine?.origin_valid ? '原点已设好' : '还没有设原点'} warn />
                    {!machine?.origin_valid ? (
                      <Button size="sm" variant="plain" onClick={() => { onOpenChange(false); navigate('/machine') }}>
                        去设原点
                      </Button>
                    ) : null}
                  </div>
                ) : null}
                <Verdict ok={!missing.length} label={missing.length ? `缺 ${missing.length} 字：${missing.slice(0, 8).join('')}` : '没有缺字'} warn />
              </div>
              <div className="rounded-lg bg-fill/50 p-3">
                <div className="text-title3 tabular-nums text-label">{result ? formatDurationSpoken(total) : '—'}</div>
                <div className="text-footnote text-secondary-label">
                  {result ? `预计 ${finishClock(total)} 写完` : '正在估算时间…'}
                  {copies > 1 && (!pr.copy_mode || pr.copy_mode === 'repeat_same') ? ` · ${copies} 份` : ''}
                  {selPages.length > 1 ? ` · ${selPages.length} 页` : ''}
                </div>
                {selPages.length ? (
                  <div className="mt-1 text-footnote tabular-nums text-secondary-label">
                    {selPages.reduce((n, p) => n + p.stats.strokes, 0).toLocaleString('zh-CN')} 笔 · 书写 {(selPages.reduce((n, p) => n + p.stats.draw_mm, 0) / 1000).toFixed(1)} m · 空走 {(selPages.reduce((n, p) => n + p.stats.travel_mm, 0) / 1000).toFixed(1)} m
                  </div>
                ) : null}
                <div className="mt-1 text-footnote text-secondary-label">根据最近完成的任务校准</div>
              </div>
              {placement.dx || placement.dy ? (
                <p className="text-footnote text-on-tint-orange">本次位置偏移 X {placement.dx.toFixed(1)} / Y {placement.dy.toFixed(1)} mm（不改设计）</p>
              ) : null}
              {busy ? (
                <div className="flex flex-col gap-1.5 rounded-lg bg-fill/50 p-3" role="status" aria-live="polite">
                  <div className="flex items-center gap-2 text-footnote text-secondary-label">
                    <Spinner size={12} />
                    <span className="min-w-0 flex-1 truncate">
                      {result ? '正在按最新设置重新计算' : '正在计算路径'}
                      {prog?.msg ? ` · ${prog.msg}` : ''}
                    </span>
                    <span className="tabular-nums">{elapsed} 秒</span>
                  </div>
                  <ProgressBar value={prog && prog.p > 0 ? prog.p : null} label="计算进度" />
                  {elapsed >= 60 ? <p className="text-footnote text-on-tint-orange">比平时久。图片多时板子算得慢，可以继续等，或取消后重试。</p> : null}
                  <div className="flex gap-2">
                    <Button size="sm" variant="gray" onClick={cancelRender}>取消</Button>
                    {elapsed >= 60 ? <Button size="sm" variant="tinted" onClick={() => setRetryN((n) => n + 1)}>重试</Button> : null}
                  </div>
                </div>
              ) : null}
              {err ? (
                <div className="flex items-start gap-2 text-footnote text-red">
                  <span className="min-w-0 flex-1">{err}</span>
                  <Button size="sm" variant="tinted" onClick={() => setRetryN((n) => n + 1)}>重试</Button>
                </div>
              ) : null}
              {/* frame step */}
              <div className="flex flex-col gap-2 rounded-lg p-3 ring-1 ring-separator">
                <div className="flex items-center gap-1.5 text-headline text-label">
                  {framed ? <CircleCheck className="size-4 text-green" /> : <Crosshair className="size-4 text-accent" />}
                  先走一遍边框 <Help topic="走边框" />
                </div>
                <p className="text-footnote text-secondary-label">笔沿着要写的区域外框走一圈，确认纸放对了、不会写出纸外。</p>
                <Segmented value={frameMode} onValueChange={setFrameMode} options={[{ value: 'up', label: '抬笔' }, { value: 'down_light', label: '轻画' }, { value: 'corners', label: '四角' }]} size="sm" block aria-label="走边框方式" />
                <div className="flex gap-2">
                  <Button size="sm" variant={framed ? 'gray' : 'tinted'} icon={<Crosshair />} loading={framing} disabled={!connected || busyMachine || !first?.machine_bbox} onClick={doFrame} title={!connected ? '先连接写字机' : undefined}>
                    {framed ? '再走一次' : '走边框'}
                  </Button>
                  <Button size="sm" variant="plain" onClick={onOpenPosition}>
                    位置预览…
                  </Button>
                </div>
              </div>
            </aside>
            {/* form */}
            <div className={cn('min-w-0 flex-1 px-4 py-3', !compact && 'overflow-y-auto')}>
              <Group title="写字机">
                <FRow label="状态">
                  {connected ? (
                    <span className="text-body text-label">{machine?.state_text || '已连接'}</span>
                  ) : (
                    <Button size="sm" variant="tinted" icon={<Plug />} onClick={() => void connectMachine().catch((e) => toast.error('连接失败', { description: errText(e) }))}>
                      连接
                    </Button>
                  )}
                </FRow>
                <FRow label="机器配置">
                  <Select value={profile?.id} onValueChange={setProfileId} options={(profiles.data ?? []).map((p) => ({ value: p.id, label: p.name + (p.is_active ? '（当前）' : '') }))} className="w-full max-w-60" />
                </FRow>
              </Group>
              <Group title="范围">
                <FRow label="页面">
                  <Segmented value={range} onValueChange={setRange} options={[{ value: 'all', label: '全部' }, { value: 'current', label: '当前页' }, { value: 'custom', label: '指定' }]} size="sm" />
                  {range === 'custom' ? <input value={custom} onChange={(e) => setCustom(e.currentTarget.value)} className="h-7 w-20 rounded-sm bg-bg-elevated px-2 text-body shadow-sm" aria-label="页码，如 1-2,4" placeholder="1-2,4" /> : null}
                </FRow>
                <ORow k="copies" label="份数" pr={pr} onReset={() => setField('copies', null)}>
                  <NumberField value={eff<number>('copies')} onChange={(v) => setField('copies', Math.max(1, Math.round(v)))} min={1} max={500} step={1} className="w-32" />
                </ORow>
                {copies > 1 ? (
                  <>
                    <ORow k="copy_mode" label="多份方式" pr={pr} onReset={() => setField('copy_mode', null)}>
                      <Select value={eff<string>('copy_mode')} onValueChange={(v) => setField('copy_mode', v)} options={[{ value: 'repeat_same', label: '每份换一张纸' }, { value: 'tile_x', label: '同一张纸横向排列' }, { value: 'tile_y', label: '同一张纸纵向排列' }]} className="w-48" />
                    </ORow>
                    {pr.copy_mode && pr.copy_mode !== 'repeat_same' ? (
                      <ORow k="copy_gap_mm" label="间隔" pr={pr} onReset={() => setField('copy_gap_mm', null)}>
                        <NumberField value={eff<number>('copy_gap_mm')} onChange={(v) => setField('copy_gap_mm', v)} unit="mm" step={1} min={0} className="w-32" />
                      </ORow>
                    ) : null}
                  </>
                ) : null}
                {outs.length > 1 ? (
                  <ORow k="multi_page" label="多页" pr={pr} onReset={() => setField('multi_page', null)}>
                    <Select value={eff<string>('multi_page')} onValueChange={(v) => setField('multi_page', v)} options={[{ value: 'separate_jobs', label: '每页一个任务（换纸）' }, { value: 'one_job_pause_between', label: '一个任务，页间暂停' }, { value: 'first_only', label: '只写第一页' }]} className="w-52" />
                  </ORow>
                ) : null}
              </Group>
              <Group title="速度" note={overriddenKeys.length ? <button type="button" className="flex items-center gap-1 text-footnote text-accent" onClick={resetAll}><RotateCcw className="size-3" />已覆盖 {overriddenKeys.length} 项 · 恢复默认</button> : null}>
                <ORow k="feed_rate" label="写字速度" pr={pr} onReset={() => setField('feed_rate', null)}>
                  <NumberField value={eff<number>('feed_rate')} onChange={(v) => setField('feed_rate', v)} unit="mm/分" step={100} min={50} max={20000} className="w-40" />
                </ORow>
                <ORow k="jog_speed" label="空走速度" pr={pr} onReset={() => setField('jog_speed', null)}>
                  <NumberField value={eff<number>('jog_speed')} onChange={(v) => setField('jog_speed', v)} unit="mm/分" step={100} min={50} max={20000} className="w-40" />
                </ORow>
                <ORow k="z_speed" label="抬落笔速度" pr={pr} onReset={() => setField('z_speed', null)}>
                  <NumberField value={eff<number>('z_speed')} onChange={(v) => setField('z_speed', v)} unit="mm/分" step={100} min={50} max={20000} className="w-40" />
                </ORow>
              </Group>
              <Group title="笔">
                <ORow k="pen_up_z" label="抬笔位" pr={pr} onReset={() => setField('pen_up_z', null)}>
                  <NumberField value={eff<number>('pen_up_z')} onChange={(v) => setField('pen_up_z', v)} step={0.1} min={0} max={20} className="w-32" />
                </ORow>
                <ORow k="pen_down_z" label="落笔深度" pr={pr} onReset={() => setField('pen_down_z', null)}>
                  <NumberField value={eff<number>('pen_down_z')} onChange={(v) => setField('pen_down_z', v)} step={0.1} min={0} max={20} className="w-32" />
                  <PenTest disabled={!connected || busyMachine} />
                </ORow>
                <ORow k="tool_on_delay" label="落笔后停顿" pr={pr} onReset={() => setField('tool_on_delay', null)}>
                  <NumberField value={eff<number>('tool_on_delay')} onChange={(v) => setField('tool_on_delay', v)} unit="秒" step={0.05} min={0} max={5} className="w-32" />
                </ORow>
                <ORow k="tool_off_delay" label="抬笔后停顿" pr={pr} onReset={() => setField('tool_off_delay', null)}>
                  <NumberField value={eff<number>('tool_off_delay')} onChange={(v) => setField('tool_off_delay', v)} unit="秒" step={0.05} min={0} max={5} className="w-32" />
                </ORow>
              </Group>
              <Group title="路径">
                <ORow k="optimize" label="笔画顺序" pr={pr} onReset={() => setField('optimize', null)}>
                  <Segmented value={eff<boolean>('optimize') ? 'opt' : 'orig'} onValueChange={(v) => setField('optimize', v === 'opt')} options={[{ value: 'orig', label: '按书写顺序' }, { value: 'opt', label: '优化空走' }]} size="sm" />
                </ORow>
                <ORow k="simplify" label="简化" pr={pr} onReset={() => setField('simplify', null)}>
                  <NumberField value={eff<number>('simplify')} onChange={(v) => setField('simplify', v)} unit="mm" step={0.05} min={0} max={2} className="w-32" />
                </ORow>
                <ORow k="near_dst" label="合并距离" pr={pr} onReset={() => setField('near_dst', null)}>
                  <NumberField value={eff<number>('near_dst')} onChange={(v) => setField('near_dst', v)} unit="mm" step={0.05} min={0} max={5} className="w-32" />
                </ORow>
              </Group>
              <Group title="原点与流程">
                <FRow label={<>开始前设原点 <Help topic="原点" /></>}>
                  <Switch
                    checked={pr.origin?.set_zero_at_start ?? origin.set_zero_at_start ?? true}
                    onCheckedChange={(v) => useStudio.getState().edit((d) => { d.print = { ...d.print, origin: { ...origin, ...(d.print?.origin ?? {}), set_zero_at_start: v } } })}
                    aria-label="开始前把当前笔位设为原点"
                  />
                </FRow>
                <ORow k="stop_on_error" label="出错时停止" pr={pr} onReset={() => setField('stop_on_error', null)}>
                  <Switch checked={eff<boolean>('stop_on_error')} onCheckedChange={(v) => setField('stop_on_error', v)} />
                </ORow>
                <button type="button" className="mt-1 text-footnote text-accent" onClick={() => setAdvanced(!advanced)} aria-expanded={advanced}>
                  {advanced ? '▾' : '▸'} 起止 G 代码（高级）
                </button>
                {advanced ? (
                  <>
                    <GcodeField label="开始时" value={eff<string>('start_gcode')} overridden={pr.start_gcode != null} onChange={(v) => setField('start_gcode', v)} onReset={() => setField('start_gcode', null)} />
                    <GcodeField label="结束时" value={eff<string>('end_gcode')} overridden={pr.end_gcode != null} onChange={(v) => setField('end_gcode', v)} onReset={() => setField('end_gcode', null)} />
                  </>
                ) : null}
              </Group>
            </div>
          </div>
          {/* footer */}
          <div className={cn('hairline-t flex shrink-0 flex-wrap items-center gap-2 px-5 py-3 pb-safe', compact && 'pr-24')}>
            <Button size="md" variant="gray" icon={<Download />} className={compact ? 'order-2' : undefined} disabled={!result} onClick={() => result && void exportRender(result.rid, { format: 'gcode', pages: selected.length ? selected : 'all', dpi: 96, space: 'page', background: false }, `${project.name}.gcode`).catch((e) => toast.error('导出失败', { description: errText(e) }))}>
              {compact ? '导出' : '导出 G 代码'}
            </Button>
            <div className={cn('min-w-2 flex-1', compact && 'hidden')} />
            <label className={cn('flex items-center gap-2 text-body', compact && 'order-1 w-full')}>
              <input type="checkbox" checked={ready} onChange={(e) => setReady(e.currentTarget.checked)} className="size-4 accent-[rgb(var(--accent))]" />
              {compact ? '纸张和笔已就位：笔已抬起，停在原点' : '纸张和笔已就位：纸已放好，笔已抬起，停在原点位置'}
            </label>
            {!framed && connected ? <span className={cn('text-footnote text-on-tint-orange', compact && 'order-1 w-full -mt-1')}>建议先走边框确认位置</span> : null}
            {outWork && isAdmin ? <span className="flex items-center gap-1 text-footnote text-red"><TriangleAlert className="size-3.5" />超出行程</span> : null}
            <Button onClick={() => onOpenChange(false)} className={compact ? 'order-2' : undefined}>取消</Button>
            <Button className={compact ? 'order-2 flex-1' : undefined} variant={outWork ? 'destructive' : 'filled'} loading={starting} disabled={!!blockReason} onClick={start} title={blockReason ?? undefined}>
              {outWork && isAdmin ? '仍要打印…' : '开始打印'}
            </Button>
          </div>
          {blockReason && blockReason !== '请确认笔已抬起并停在起点' ? <p className="-mt-2 px-5 pb-3 text-right text-footnote text-secondary-label">{blockReason}</p> : null}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function Verdict({ ok, label, detail, warn }: { ok: boolean; label: string; detail?: string; warn?: boolean }) {
  const Icon = ok ? CircleCheck : warn ? TriangleAlert : CircleX
  return (
    <div className="flex items-center gap-2">
      <Icon className={cn('size-4 shrink-0', ok ? 'text-green' : warn ? 'text-orange' : 'text-red')} aria-hidden />
      <span className={cn('min-w-0 flex-1 truncate', !ok && !warn && 'font-medium text-red')}>{label}</span>
      {detail ? <span className="shrink-0 text-footnote tabular-nums text-secondary-label">{detail}</span> : null}
      <span className="sr-only">{ok ? '通过' : '有问题'}</span>
    </div>
  )
}

/** Paper + reference background + travel area + drawing bbox thumbnail; the origin dot can be dragged. */
function FitPreview({ paper, bbox, work, outWork, origin, content, bg }: { paper: PaperBase; bbox: number[] | null; work: { x: number; y: number; w: number; h: number } | null; outWork: boolean; origin: OriginSpec; content: ContentBox; bg: PageBackground | null }) {
  const { w, h } = paperDims(paper)
  const originAt = originPoint(origin, w, h, content)
  const svgRef = React.useRef<SVGSVGElement>(null)
  const readOnly = useStudio((s) => s.readOnly)
  const boxes = content ? [{ box: content, label: '内容角' }] : []
  const drag = useSvgOriginDrag({ svg: svgRef, origin, w, h, content, snap: originSnapPoints(paper, boxes, bg), lines: originSnapLines(paper), disabled: readOnly })
  const x0 = Math.min(0, work?.x ?? 0) - 4
  const y0 = Math.min(0, work?.y ?? 0) - 4
  const x1 = Math.max(w, work ? work.x + work.w : w) + 4
  const y1 = Math.max(h, work ? work.y + work.h : h) + 4
  return (
    <svg ref={svgRef} viewBox={`${x0} ${y0} ${x1 - x0} ${y1 - y0}`} className="h-44 w-full touch-none rounded-lg bg-canvas-desk" role="img" aria-label="纸张与行程预览">
      {work ? <rect x={work.x} y={work.y} width={work.w} height={work.h} fill="none" stroke="rgb(var(--travel))" strokeDasharray="4 3" strokeWidth={1} vectorEffect="non-scaling-stroke" /> : null}
      <rect x={0} y={0} width={w} height={h} fill="rgb(var(--canvas-paper))" />
      <BackgroundImage bg={bg} />
      <rect x={paper.margins.l} y={paper.margins.t} width={w - paper.margins.l - paper.margins.r} height={h - paper.margins.t - paper.margins.b} fill="none" stroke="rgb(var(--gray))" strokeOpacity={0.5} strokeDasharray="2 2" strokeWidth={0.75} vectorEffect="non-scaling-stroke" />
      {bbox ? (
        <rect x={bbox[0]} y={bbox[1]} width={bbox[2] - bbox[0]} height={bbox[3] - bbox[1]} fill={outWork ? 'rgb(var(--red) / 0.15)' : 'rgb(var(--accent) / 0.12)'} stroke={outWork ? 'rgb(var(--red))' : 'rgb(var(--accent))'} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
      ) : null}
      <circle cx={originAt.x} cy={originAt.y} r={Math.max(w, h) / (drag.dragging ? 40 : 60)} fill="rgb(var(--axis-origin))" stroke="rgb(var(--canvas-paper))" strokeWidth={1} vectorEffect="non-scaling-stroke" pointerEvents="none" />
      {!readOnly ? (
        <circle cx={originAt.x} cy={originAt.y} r={Math.max(w, h) / 14} fill="transparent" style={{ cursor: drag.dragging ? 'grabbing' : 'grab' }} {...drag.handlers} role="button" aria-label="拖动原点">
          <title>原点：开始前笔（抬起）停在这里 · 可拖动</title>
        </circle>
      ) : null}
      {drag.label ? (
        <text x={originAt.x + Math.max(w, h) / 30} y={originAt.y - Math.max(w, h) / 40} fontSize={Math.max(w, h) / 22} fill="rgb(var(--pink))" pointerEvents="none">
          {drag.label}
        </text>
      ) : null}
    </svg>
  )
}

function Group({ title, children, note }: { title: string; children: React.ReactNode; note?: React.ReactNode }) {
  return (
    <section className="mb-4">
      <div className="mb-1 flex items-center justify-between px-1">
        <h3 className="text-footnote font-semibold text-secondary-label">{title}</h3>
        {note}
      </div>
      <div className="flex flex-col rounded-lg bg-bg-grouped-secondary px-2 py-1 shadow-sm ring-1 ring-separator/40">{children}</div>
    </section>
  )
}

function FRow({ label, children }: { label: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex min-h-10 items-center gap-3 px-1 py-1 pointer-coarse:min-h-12">
      <span className="flex w-28 shrink-0 items-center gap-1 text-body text-label">{label}</span>
      <div className="flex min-w-0 flex-1 items-center justify-end gap-2">{children}</div>
    </div>
  )
}

function ORow({ k, label, pr, onReset, children }: { k: OverrideKey; label: string; pr: PrintOverrides; onReset: () => void; children: React.ReactNode }) {
  const over = pr[k] != null
  return (
    <FRow
      label={
        <>
          <span className={cn('size-1.5 shrink-0 rounded-full', over ? 'bg-overridden' : 'bg-transparent')} aria-label={over ? '已覆盖' : undefined} role={over ? 'img' : undefined} />
          {label}
        </>
      }
    >
      {children}
      {over ? (
        <button type="button" onClick={onReset} className="press shrink-0 rounded-sm p-1 text-secondary-label hover:text-label pointer-coarse:p-2.5" aria-label={`${label} 恢复默认`} title="恢复默认">
          <RotateCcw className="size-3.5" />
        </button>
      ) : (
        <span className="w-[22px] shrink-0 pointer-coarse:w-[34px]" />
      )}
    </FRow>
  )
}

function GcodeField({ label, value, overridden, onChange, onReset }: { label: string; value: string; overridden: boolean; onChange: (v: string) => void; onReset: () => void }) {
  return (
    <div className="flex flex-col gap-1 px-1 py-1.5">
      <div className="flex items-center gap-1.5 text-footnote text-secondary-label">
        <span className={cn('size-1.5 rounded-full', overridden ? 'bg-overridden' : 'bg-transparent')} />
        {label}
        {overridden ? (
          <button type="button" className="ml-auto text-accent" onClick={onReset}>
            恢复默认
          </button>
        ) : null}
      </div>
      <Textarea value={value} onChange={(e) => onChange(e.currentTarget.value)} rows={3} spellCheck={false} className="font-mono text-footnote" placeholder="（无）" />
    </div>
  )
}

function PenTest({ disabled }: { disabled: boolean }) {
  const send = (state: 'up' | 'down') => api.post('/machine/pen', { state }).catch((e) => toast.error('测试失败', { description: errText(e) }))
  return (
    <div className="flex shrink-0 gap-1">
      <Button size="sm" variant="gray" disabled={disabled} onClick={() => void send('down')}>
        落
      </Button>
      <Button size="sm" variant="gray" disabled={disabled} onClick={() => void send('up')} icon={<Check className="hidden" />}>
        抬
      </Button>
    </div>
  )
}
