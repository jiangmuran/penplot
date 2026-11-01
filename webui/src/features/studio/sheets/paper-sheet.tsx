/** 纸张选择 Sheet (02-ux §3.2): presets by category, custom W×H, orientation, margins, save "我的纸张", apply scope. */
import { useMutation } from '@tanstack/react-query'
import { ArrowUpDown, Check, Link2, Link2Off, Star, Trash2 } from 'lucide-react'
import * as React from 'react'
import { api } from '@/api/client'
import { qk, queryClient } from '@/api/query'
import type { Margins, PaperBase, PaperRef, PaperSpec } from '@/api/studio'
import {
  Button, Dialog, DialogContent, DialogTitle, IconButton, Input, NumberField, Popover, PopoverContent, PopoverTrigger,
  SearchField, Segmented, Select,
} from '@/components/ui'
import { cn } from '@/lib/cn'
import { confirm } from '@/lib/confirm'
import { useIsCompact } from '@/lib/media'
import { toast } from '@/lib/toast'
import { elementAABB } from '../actions'
import { usePapers } from '../data'
import { contains } from '../geometry'
import { FALLBACK_PAPER, fromUnit, paperDims, toUnit, type Unit } from '../model'
import { useStudio } from '../store'

interface Preset {
  name: string
  w: number
  h: number
  cat: string
  landscape?: boolean
}

const PRESETS: Preset[] = [
  { cat: 'ISO A / B', name: 'A3', w: 297, h: 420 },
  { cat: 'ISO A / B', name: 'A4', w: 210, h: 297 },
  { cat: 'ISO A / B', name: 'A5', w: 148, h: 210 },
  { cat: 'ISO A / B', name: 'A6', w: 105, h: 148 },
  { cat: 'ISO A / B', name: 'B5', w: 176, h: 250 },
  { cat: 'ISO A / B', name: 'JIS B5', w: 182, h: 257 },
  { cat: '中国开本', name: '16 开', w: 185, h: 260 },
  { cat: '中国开本', name: '大 16 开', w: 210, h: 285 },
  { cat: '中国开本', name: '32 开', w: 130, h: 184 },
  { cat: '中国开本', name: '8 开', w: 260, h: 370 },
  { cat: '北美', name: 'Letter', w: 215.9, h: 279.4 },
  { cat: '北美', name: 'Legal', w: 215.9, h: 355.6 },
  { cat: '北美', name: 'Tabloid', w: 279.4, h: 431.8 },
  { cat: '信封', name: 'DL 信封', w: 220, h: 110, landscape: true },
  { cat: '信封', name: 'C5 信封', w: 229, h: 162, landscape: true },
  { cat: '信封', name: 'C6 信封', w: 162, h: 114, landscape: true },
  { cat: '信封', name: '中式 5 号', w: 220, h: 110, landscape: true },
  { cat: '信封', name: '中式 7 号', w: 229, h: 162, landscape: true },
  { cat: '信封', name: '#10 信封', w: 241, h: 105, landscape: true },
  { cat: '卡片', name: '明信片', w: 148, h: 100, landscape: true },
  { cat: '卡片', name: '贺卡（A5 对折）', w: 148, h: 210 },
  { cat: '卡片', name: '贺卡 A6', w: 148, h: 105, landscape: true },
  { cat: '卡片', name: '名片', w: 90, h: 54, landscape: true },
  { cat: '卡片', name: '名片（欧美）', w: 85, h: 55, landscape: true },
  { cat: '卡片', name: '便签', w: 76, h: 76 },
  { cat: '卡片', name: '4×6 照片卡', w: 152.4, h: 101.6, landscape: true },
  { cat: '卡片', name: '5×7 卡片', w: 177.8, h: 127, landscape: true },
]

const MARGIN_PRESETS: Record<string, Margins> = {
  normal: { l: 31.8, r: 31.8, t: 25.4, b: 25.4 },
  narrow: { l: 12.7, r: 12.7, t: 12.7, b: 12.7 },
  moderate: { l: 19.1, r: 19.1, t: 25.4, b: 25.4 },
  wide: { l: 50.8, r: 50.8, t: 25.4, b: 25.4 },
  none: { l: 0, r: 0, t: 0, b: 0 },
}

interface Draft {
  spec: PaperBase
  /** backend paper id, when unchanged from a stored paper */
  id: string | null
  base: string
}

export function PaperSheet({ open, onOpenChange, current, currentRef }: { open: boolean; onOpenChange: (o: boolean) => void; current: PaperBase; currentRef: PaperRef }) {
  const compact = useIsCompact()
  const papers = usePapers()
  const unit = useStudio((s) => s.overlays.unit)
  const [cat, setCat] = React.useState('ISO A / B')
  const [q, setQ] = React.useState('')
  const [draft, setDraft] = React.useState<Draft>({ spec: current, id: currentRef.paper_id ?? null, base: current.name })
  const [linked, setLinked] = React.useState(false)
  const [scope, setScope] = React.useState<'all' | 'page'>('all')
  React.useEffect(() => {
    if (open) {
      setDraft({ spec: current, id: currentRef.paper_id ?? null, base: current.name })
      const spec = papers.data?.find((p) => p.id === currentRef.paper_id)
      setCat(spec ? (spec.builtin ? '原软件预设' : '我的纸张') : PRESETS.find((p) => p.name === current.name)?.cat ?? 'ISO A / B')
    }
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  const mine = (papers.data ?? []).filter((p) => !p.builtin)
  const builtin = (papers.data ?? []).filter((p) => p.builtin)
  const cats = ['我的纸张', ...new Set(PRESETS.map((p) => p.cat)), '原软件预设']
  const ql = q.trim().toLowerCase()

  type Card = { key: string; name: string; w: number; h: number; spec: PaperBase; id: string | null; mine?: PaperSpec }
  const cards: Card[] = []
  const pushPreset = (p: Preset) => {
    const m = draft.spec.margins
    cards.push({
      key: `pre-${p.name}`,
      name: p.name,
      w: p.w,
      h: p.h,
      id: null,
      spec: { ...FALLBACK_PAPER, name: p.name, width_mm: Math.min(p.w, p.h), height_mm: Math.max(p.w, p.h), orientation: p.landscape ? 'landscape' : 'portrait', margins: p.w < 120 || p.h < 120 ? MARGIN_PRESETS.narrow : m, rotation: 0 },
    })
  }
  const pushSpec = (p: PaperSpec, isMine: boolean) => {
    const { w, h } = paperDims(p)
    cards.push({ key: p.id, name: p.name, w, h, id: p.id, spec: p, mine: isMine ? p : undefined })
  }
  if (ql) {
    PRESETS.filter((p) => p.name.toLowerCase().includes(ql)).forEach(pushPreset)
    ;(papers.data ?? []).filter((p) => p.name.toLowerCase().includes(ql)).forEach((p) => pushSpec(p, !p.builtin))
  } else if (cat === '我的纸张') mine.forEach((p) => pushSpec(p, true))
  else if (cat === '原软件预设') builtin.forEach((p) => pushSpec(p, false))
  else PRESETS.filter((p) => p.cat === cat).forEach(pushPreset)

  const s = draft.spec
  const dims = paperDims(s)
  const setSpec = (patch: Partial<PaperBase>, keepId = false) => setDraft((d) => ({ spec: { ...d.spec, ...patch, name: keepId ? d.spec.name : d.spec.name.startsWith('自定义') ? d.spec.name : `自定义（基于 ${d.base}）` }, id: keepId ? d.id : null, base: d.base }))
  const setDim = (axis: 'w' | 'h', v: number) => {
    const mm = fromUnit(v, unit)
    // edit in displayed orientation
    const land = s.orientation === 'landscape'
    if ((axis === 'w') !== land) setSpec({ width_mm: mm })
    else setSpec({ height_mm: mm })
  }
  const setMargin = (k: keyof Margins, v: number) => {
    const mm = fromUnit(v, unit)
    setSpec({ margins: linked ? { l: mm, r: mm, t: mm, b: mm } : { ...s.margins, [k]: mm } })
  }
  const marginPreset = Object.entries(MARGIN_PRESETS).find(([, m]) => JSON.stringify(m) === JSON.stringify(s.margins))?.[0] ?? 'custom'

  const saveMine = useMutation({
    mutationFn: (name: string) => api.post<PaperSpec>('/papers', { ...s, name }),
    meta: { errorTitle: '保存纸张失败' },
    onSuccess: (p) => {
      void queryClient.invalidateQueries({ queryKey: qk.papers.all })
      setDraft({ spec: p, id: p.id, base: p.name })
      toast.success('已保存为我的纸张', { description: p.name })
    },
  })
  const delMine = useMutation({
    mutationFn: (id: string) => api.delete(`/papers/${id}`),
    meta: { errorTitle: '删除纸张失败' },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: qk.papers.all }),
  })

  const apply = () => {
    const ref: PaperRef = draft.id ? { paper_id: draft.id, spec: null } : { paper_id: null, spec: draft.spec }
    const st = useStudio.getState()
    st.edit((doc) => {
      if (scope === 'page') doc.pages[st.view.page].paper = ref
      else {
        doc.paper = ref
        for (const p of doc.pages) p.paper = null
      }
    })
    onOpenChange(false)
    // out-of-paper check
    const page = useStudio.getState().doc?.pages[st.view.page]
    const { w, h } = paperDims(draft.spec)
    const out = page?.elements.filter((e) => !e.hidden && !contains({ x: 0, y: 0, w, h }, elementAABB(e, draft.spec))) ?? []
    if (out.length) toast.warning(`${out.length} 个元素超出纸张`, { action: { label: '查看', onClick: () => useStudio.setState({ selection: out.map((e) => e.id) }) } })
  }

  const k = 1 / 1
  const u = (v: number) => Math.round(toUnit(v, unit) * 1000) / 1000
  const step = unit === 'in' ? 0.01 : 0.5

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="xl" onOpenAutoFocus={(e) => e.preventDefault()} className={cn(compact ? 'h-[100dvh] max-h-none w-screen max-w-none rounded-none' : 'h-[min(600px,calc(100dvh-32px))] max-w-[820px]')}>
        <div className="flex h-full min-h-0 flex-col">
          <div className="hairline-b flex shrink-0 items-center gap-3 px-5 py-3 pr-12">
            <DialogTitle>选择纸张</DialogTitle>
            <SearchField value={q} onValueChange={setQ} placeholder="搜索纸张" className="ml-auto w-48" />
          </div>
          <div className={cn('flex min-h-0 flex-1', compact && 'flex-col overflow-y-auto')}>
            {/* categories */}
            <nav className={cn('shrink-0', compact ? 'flex gap-1 overflow-x-auto px-3 py-2 scrollbar-none' : 'hairline-r w-40 overflow-y-auto p-2')} aria-label="纸张分类">
              {cats.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => {
                    setCat(c)
                    setQ('')
                  }}
                  className={cn(
                    'focus-ring flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-sm px-2 text-left text-body pointer-coarse:h-10',
                    !compact && 'w-full',
                    cat === c && !ql ? 'bg-accent/15 text-accent' : 'text-label hover:bg-quaternary-fill',
                  )}
                >
                  {c === '我的纸张' ? <Star className="size-3.5" /> : null}
                  <span className="flex-1">{c}</span>
                  {c === '我的纸张' ? <span className="text-caption text-tertiary-label">{mine.length}</span> : null}
                </button>
              ))}
            </nav>
            {/* cards */}
            <div className={cn('min-w-0 flex-1 p-3', !compact && 'overflow-y-auto')}>
              {cards.length === 0 ? (
                <p className="py-10 text-center text-footnote text-secondary-label">{cat === '我的纸张' ? '还没有保存的纸张。在右侧修改尺寸后点「保存为我的纸张」。' : '没有匹配的纸张'}</p>
              ) : (
                <div className="grid grid-cols-[repeat(auto-fill,minmax(104px,1fr))] gap-2">
                  {cards.map((c) => {
                    const sel = (draft.id && draft.id === c.id) || (!draft.id && !c.id && c.spec.width_mm === s.width_mm && c.spec.height_mm === s.height_mm && c.spec.orientation === s.orientation && c.name === draft.base)
                    const kk = 64 / Math.max(c.w, c.h)
                    return (
                      <div key={c.key} className="group relative">
                        <button
                          type="button"
                          onClick={() => setDraft({ spec: { ...c.spec, margins: c.id ? c.spec.margins : c.spec.margins }, id: c.id, base: c.name })}
                          className={cn('press focus-ring flex w-full flex-col items-center gap-1.5 rounded-lg p-2', sel ? 'bg-accent/10 ring-2 ring-accent' : 'hover:bg-quaternary-fill')}
                          aria-pressed={!!sel}
                        >
                          <span className="flex h-[68px] items-center justify-center">
                            <span className="bg-canvas-paper shadow-paper" style={{ width: c.w * kk, height: c.h * kk }} />
                          </span>
                          <span className="w-full truncate text-center text-footnote font-medium text-label">{c.name}</span>
                          <span className="text-caption tabular-nums text-secondary-label">
                            {u(c.w)}×{u(c.h)}
                          </span>
                          {sel ? <Check className="absolute right-1.5 top-1.5 size-4 rounded-full bg-accent p-0.5 text-white" strokeWidth={3} /> : null}
                        </button>
                        {c.mine ? (
                          <IconButton
                            label="删除此纸张"
                            size="sm"
                            className="absolute left-1 top-1 opacity-0 group-hover:opacity-100 pointer-coarse:opacity-70"
                            onClick={async () => {
                              if (await confirm({ title: `删除纸张「${c.name}」？`, confirmLabel: '删除', destructive: true })) delMine.mutate(c.mine!.id)
                            }}
                          >
                            <Trash2 />
                          </IconButton>
                        ) : null}
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
            {/* custom */}
            <aside className={cn('flex shrink-0 flex-col gap-2 p-4', compact ? 'hairline-t' : 'hairline-l w-64 overflow-y-auto')}>
              <div className="flex items-center justify-between">
                <h3 className="truncate text-headline text-label">{s.name}</h3>
                <Segmented value={unit} onValueChange={(v) => useStudio.getState().setOverlay('unit', v)} options={[{ value: 'mm' as Unit, label: 'mm' }, { value: 'in' as Unit, label: 'in' }]} size="sm" />
              </div>
              <label className="flex items-center gap-2 text-footnote text-secondary-label">
                <span className="w-6">宽</span>
                <NumberField value={u(dims.w)} onChange={(v) => setDim('w', v)} unit={unit} step={step} min={10} className="flex-1" aria-label="宽" />
              </label>
              <label className="flex items-center gap-2 text-footnote text-secondary-label">
                <span className="w-6">高</span>
                <NumberField value={u(dims.h)} onChange={(v) => setDim('h', v)} unit={unit} step={step} min={10} className="flex-1" aria-label="高" />
              </label>
              <div className="flex items-center gap-2">
                <Segmented
                  value={s.orientation}
                  onValueChange={(o) => setSpec({ orientation: o }, true)}
                  options={[{ value: 'portrait', label: '纵向' }, { value: 'landscape', label: '横向' }]}
                  size="sm"
                  block
                  aria-label="方向"
                />
                <IconButton label="交换宽高" size="sm" onClick={() => setSpec({ orientation: s.orientation === 'portrait' ? 'landscape' : 'portrait' }, true)}>
                  <ArrowUpDown />
                </IconButton>
              </div>
              <label className="flex items-center gap-2 text-footnote text-secondary-label">
                <span className="w-12 shrink-0">放置旋转</span>
                <Select value={String(s.rotation)} onValueChange={(v) => setSpec({ rotation: Number(v) as PaperBase['rotation'] }, true)} options={[0, 90, 180, 270].map((r) => ({ value: String(r), label: `${r}°` }))} className="flex-1" />
              </label>
              <div className="mt-1 flex items-center justify-between">
                <span className="text-footnote font-semibold text-secondary-label">边距</span>
                <IconButton label={linked ? '取消联动' : '四边联动'} size="sm" active={linked} onClick={() => setLinked(!linked)}>
                  {linked ? <Link2 /> : <Link2Off />}
                </IconButton>
              </div>
              <div className="grid grid-cols-2 gap-1.5">
                {(['t', 'b', 'l', 'r'] as const).map((m) => (
                  <label key={m} className="flex items-center gap-1 text-footnote text-secondary-label">
                    <span className="w-3">{{ t: '上', b: '下', l: '左', r: '右' }[m]}</span>
                    <NumberField value={u(s.margins[m])} onChange={(v) => setMargin(m, v)} unit={unit} step={unit === 'in' ? 0.05 : 0.5} min={0} stepper={false} className="min-w-0 flex-1" aria-label={`边距 ${m}`} />
                  </label>
                ))}
              </div>
              <Segmented
                value={marginPreset as 'normal'}
                onValueChange={(v) => v in MARGIN_PRESETS && setSpec({ margins: MARGIN_PRESETS[v] })}
                options={[{ value: 'normal', label: '普通' }, { value: 'narrow', label: '窄' }, { value: 'moderate', label: '适中' }, { value: 'wide', label: '宽' }]}
                size="sm"
                block
                aria-label="边距预设"
              />
              <div className="flex justify-center py-2" aria-hidden>
                <span className="relative bg-canvas-paper shadow-paper" style={{ width: dims.w * (110 / Math.max(dims.w, dims.h)) * k, height: dims.h * (110 / Math.max(dims.w, dims.h)) }}>
                  <span
                    className="absolute border border-dashed border-gray/70"
                    style={{ left: `${(s.margins.l / dims.w) * 100}%`, right: `${(s.margins.r / dims.w) * 100}%`, top: `${(s.margins.t / dims.h) * 100}%`, bottom: `${(s.margins.b / dims.h) * 100}%` }}
                  />
                </span>
              </div>
              <SaveMine onSave={(n) => saveMine.mutate(n)} busy={saveMine.isPending} defaultName={s.name.replace(/^自定义（基于 (.*)）$/, '$1 自定义')} />
            </aside>
          </div>
          <div className={cn('hairline-t flex shrink-0 items-center justify-end gap-2 px-5 py-3 pb-safe', compact && 'pr-24')}>
            <Select value={scope} onValueChange={(v) => setScope(v as 'all' | 'page')} options={[{ value: 'all', label: '应用到全部页' }, { value: 'page', label: '仅当前页' }]} className="w-36" />
            <Button onClick={() => onOpenChange(false)}>取消</Button>
            <Button variant="filled" onClick={apply}>
              应用
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function SaveMine({ onSave, busy, defaultName }: { onSave: (n: string) => void; busy: boolean; defaultName: string }) {
  const [open, setOpen] = React.useState(false)
  const [name, setName] = React.useState(defaultName)
  React.useEffect(() => {
    if (open) setName(defaultName)
  }, [open, defaultName])
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button size="sm" variant="gray" icon={<Star />} loading={busy}>
          保存为我的纸张
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64">
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            if (!name.trim()) return
            onSave(name.trim())
            setOpen(false)
          }}
        >
          <span className="text-footnote font-medium text-secondary-label">名称</span>
          <Input autoFocus value={name} onChange={(e) => setName(e.currentTarget.value)} />
          <Button type="submit" variant="filled" size="sm">
            保存
          </Button>
        </form>
      </PopoverContent>
    </Popover>
  )
}
