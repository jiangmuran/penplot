/** 设置 › 纸张预设: builtin presets (read-only) + custom paper CRUD (04 §7). */
import { Lock, Pencil, Plus, Trash2 } from 'lucide-react'
import * as React from 'react'
import { recentPaperIds, touchRecentPaper } from '@/api/recent-papers'
import { useDeletePaper, usePapers, useSavePaper, type PaperBase, type PaperSpec } from '@/api/profiles'
import {
  Button, Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle, FormField, GroupedList, IconButton,
  Input, NumberField, Segmented, Select, SkeletonList,
} from '@/components/ui'
import { useIsCompact } from '@/lib/media'
import { toast } from '@/lib/toast'
import { HelpLink } from '@/features/help/HelpLink'
import { padUnit, QueryError, UNIT_FIX, SectionIntro } from './shared'

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T

const BLANK: PaperBase = {
  name: '',
  width_mm: 209,
  height_mm: 296,
  margins: { l: 25, r: 25, t: 25, b: 25 },
  orientation: 'portrait',
  rotation: 0,
  ruling: { line_num: 20, line_gap: 0, line_gap_offset: 0, base_line: 1 },
}

/** One-click presets for cards and envelopes (not builtin on the server). */
const COMMON_PAPERS: PaperBase[] = [
  { name: '明信片 148×100', width_mm: 100, height_mm: 148, orientation: 'landscape', rotation: 0, margins: { l: 8, r: 8, t: 8, b: 8 }, ruling: { line_num: 6, line_gap: 0, line_gap_offset: 0, base_line: 1 } },
  { name: '贺卡对折 A5', width_mm: 148, height_mm: 210, orientation: 'portrait', rotation: 0, margins: { l: 15, r: 15, t: 20, b: 20 }, ruling: { line_num: 10, line_gap: 0, line_gap_offset: 0, base_line: 1 } },
  { name: 'DL 信封 220×110', width_mm: 110, height_mm: 220, orientation: 'landscape', rotation: 0, margins: { l: 10, r: 10, t: 10, b: 10 }, ruling: { line_num: 5, line_gap: 0, line_gap_offset: 0, base_line: 1 } },
  { name: '信纸 16 开', width_mm: 185, height_mm: 260, orientation: 'portrait', rotation: 0, margins: { l: 20, r: 20, t: 25, b: 20 }, ruling: { line_num: 18, line_gap: 0, line_gap_offset: 0, base_line: 1 } },
]

function dims(p: PaperBase) {
  const land = p.orientation === 'landscape'
  return { w: land ? p.height_mm : p.width_mm, h: land ? p.width_mm : p.height_mm }
}

/** Proportional thumbnail: paper, margin box, ruling lines. */
export function PaperPreview({ paper, size = 44 }: { paper: PaperBase; size?: number }) {
  const { w, h } = dims(paper)
  const s = size / Math.max(w, h, 1)
  const pw = Math.max(4, w * s)
  const ph = Math.max(4, h * s)
  const m = paper.margins ?? {}
  const land = paper.orientation === 'landscape'
  // margins are defined on the portrait sheet; rotate for landscape
  const ml = (land ? m.t : m.l) ?? 0
  const mr = (land ? m.b : m.r) ?? 0
  const mt = (land ? m.r : m.t) ?? 0
  const mb = (land ? m.l : m.b) ?? 0
  const bw = Math.max(0, w - ml - mr) * s
  const bh = Math.max(0, h - mt - mb) * s
  const n = size >= 80 ? Math.min(paper.ruling?.line_num ?? 0, 40) : 0
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden className="shrink-0 overflow-visible">
      <g transform={`translate(${(size - pw) / 2} ${(size - ph) / 2})`}>
        <rect width={pw} height={ph} rx={1.5} className="fill-canvas-paper" style={{ filter: 'drop-shadow(0 0.5px 1px rgb(0 0 0 / 0.25))' }} />
        <rect x={ml * s} y={mt * s} width={bw} height={bh} fill="none" className="stroke-guide" strokeWidth={0.75} strokeDasharray="2 1.5" />
        {Array.from({ length: n }, (_, i) => (
          <line key={i} x1={ml * s} x2={ml * s + bw} y1={mt * s + ((i + 1) * bh) / (n + 1)} y2={mt * s + ((i + 1) * bh) / (n + 1)} className="stroke-guide" strokeOpacity={0.45} strokeWidth={0.5} />
        ))}
      </g>
    </svg>
  )
}

function fmtMM(n: number | undefined) {
  return n == null ? '—' : Number(n.toFixed(1)).toString()
}

function paperSubtitle(p: PaperSpec) {
  const { w, h } = dims(p)
  const m = p.margins ?? {}
  return `${fmtMM(w)} × ${fmtMM(h)} mm · 边距 ${fmtMM(m.t)}/${fmtMM(m.r)}/${fmtMM(m.b)}/${fmtMM(m.l)} · ${p.ruling?.line_num ?? 0} 行`
}

function Num({ id, label, value, onChange, unit = 'mm', min = 0, max = 2000, step = 0.1 }: { id: string; label: string; value: number | undefined; onChange: (v: number) => void; unit?: string; min?: number; max?: number; step?: number }) {
  return (
    <FormField label={label} htmlFor={id}>
      <NumberField id={id} value={value ?? null} onChange={onChange} unit={padUnit(unit)} min={min} max={max} step={step} stepper={false} className={unit ? UNIT_FIX : undefined} />
    </FormField>
  )
}

function PaperDialog({ open, onOpenChange, initial }: { open: boolean; onOpenChange: (o: boolean) => void; initial: PaperSpec | null }) {
  const save = useSavePaper()
  const [p, setP] = React.useState<PaperBase>(BLANK)
  React.useEffect(() => {
    if (!open) return
    if (initial) {
      const { id: _id, builtin: _b, ...rest } = initial
      setP(clone({ ...BLANK, ...rest, margins: { ...BLANK.margins, ...rest.margins }, ruling: { ...BLANK.ruling, ...rest.ruling } }))
    } else setP(clone(BLANK))
  }, [open, initial])
  const m = p.margins ?? {}
  const r = p.ruling ?? {}
  const setM = (k: 'l' | 'r' | 't' | 'b', v: number) => setP((x) => ({ ...x, margins: { ...x.margins, [k]: v } }))
  const setR = (k: keyof NonNullable<PaperBase['ruling']>, v: number) => setP((x) => ({ ...x, ruling: { ...x.ruling, [k]: v } }))
  const boxW = p.width_mm - (m.l ?? 0) - (m.r ?? 0)
  const boxH = p.height_mm - (m.t ?? 0) - (m.b ?? 0)
  const invalid = !p.name.trim() ? '填写名称' : boxW <= 0 || boxH <= 0 ? '边距太大，没有书写区域了' : null

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (invalid) return
    try {
      const saved = await save.mutateAsync({ id: initial?.id, body: { ...p, name: p.name.trim() } })
      touchRecentPaper(saved.id)
      toast.success(initial ? '已保存纸张' : `已添加「${p.name.trim()}」`)
      onOpenChange(false)
    } catch {
      /* toasted */
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <form onSubmit={submit} className="flex min-h-0 flex-col">
          <DialogHeader>
            <DialogTitle>{initial ? '编辑纸张' : '新建纸张'}</DialogTitle>
          </DialogHeader>
          <DialogBody>
            <div className="flex flex-col gap-5 sm:flex-row">
              <div className="flex shrink-0 flex-col items-center justify-center gap-2 rounded-lg bg-canvas-desk p-4 sm:w-44">
                <PaperPreview paper={p} size={128} />
                <p className="text-center text-footnote text-secondary-label tabular-nums">
                  书写区 {fmtMM(Math.max(0, boxW))} × {fmtMM(Math.max(0, boxH))} mm
                </p>
              </div>
              <div className="flex min-w-0 flex-1 flex-col gap-4">
                <FormField label="名称" htmlFor="paper-name" error={!p.name.trim() && save.isError ? '填写名称' : undefined}>
                  <Input id="paper-name" autoFocus value={p.name} maxLength={60} placeholder="例如：B5 信纸" onChange={(e) => { const name = e.currentTarget.value; setP((x) => ({ ...x, name })) }} />
                </FormField>
                <div className="grid grid-cols-2 gap-3">
                  <Num id="paper-w" label="宽度" value={p.width_mm} onChange={(v) => setP((x) => ({ ...x, width_mm: v }))} min={10} />
                  <Num id="paper-h" label="高度" value={p.height_mm} onChange={(v) => setP((x) => ({ ...x, height_mm: v }))} min={10} />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <FormField label="方向">
                    <Segmented
                      block
                      aria-label="方向"
                      value={p.orientation ?? 'portrait'}
                      onValueChange={(v) => setP((x) => ({ ...x, orientation: v }))}
                      options={[{ value: 'portrait', label: '纵向' }, { value: 'landscape', label: '横向' }]}
                    />
                  </FormField>
                  <FormField label="上机旋转" htmlFor="paper-rot">
                    <Select
                      id="paper-rot"
                      value={String(p.rotation ?? 0)}
                      onValueChange={(v) => setP((x) => ({ ...x, rotation: Number(v) as PaperBase['rotation'] }))}
                      options={[0, 90, 180, 270].map((d) => ({ value: String(d), label: `${d}°` }))}
                    />
                  </FormField>
                </div>
                <fieldset>
                  <legend className="mb-1.5 text-footnote font-medium text-secondary-label">边距</legend>
                  <div className="grid grid-cols-4 gap-2">
                    <Num id="m-t" label="上" value={m.t} onChange={(v) => setM('t', v)} />
                    <Num id="m-r" label="右" value={m.r} onChange={(v) => setM('r', v)} />
                    <Num id="m-b" label="下" value={m.b} onChange={(v) => setM('b', v)} />
                    <Num id="m-l" label="左" value={m.l} onChange={(v) => setM('l', v)} />
                  </div>
                </fieldset>
                <fieldset>
                  <legend className="mb-1.5 text-footnote font-medium text-secondary-label">行格（信笺模式）</legend>
                  <div className="grid grid-cols-3 gap-2">
                    <Num id="r-n" label="行数" value={r.line_num} onChange={(v) => setR('line_num', Math.round(v))} unit="行" min={0} max={200} step={1} />
                    <Num id="r-gap" label="行距" value={r.line_gap} onChange={(v) => setR('line_gap', v)} min={0} max={100} />
                    <Num id="r-base" label="基线" value={r.base_line} onChange={(v) => setR('base_line', v)} unit="" min={0} max={2} step={0.05} />
                  </div>
                  <p className="mt-1.5 text-footnote text-secondary-label">行距 0 表示按行数平分书写区；基线为字身中的比例位置。</p>
                </fieldset>
                {invalid && p.name.trim() ? <p role="alert" className="text-footnote text-red">{invalid}</p> : null}
              </div>
            </div>
          </DialogBody>
          <DialogFooter>
            <Button onClick={() => onOpenChange(false)}>取消</Button>
            <Button type="submit" variant="filled" loading={save.isPending} disabled={!!invalid}>
              {initial ? '保存' : '添加'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export function PapersSection({ onActions }: { onActions?: (n: React.ReactNode) => void }) {
  const papers = usePapers()
  const del = useDeletePaper()
  const save = useSavePaper()
  const compact = useIsCompact()
  const [editing, setEditing] = React.useState<PaperSpec | null>(null)
  const [open, setOpen] = React.useState(false)
  const openNew = React.useCallback(() => {
    setEditing(null)
    setOpen(true)
  }, [])

  React.useEffect(() => {
    onActions?.(
      compact ? (
        <IconButton label="新建纸张" onClick={openNew}>
          <Plus />
        </IconButton>
      ) : (
        <Button variant="filled" icon={<Plus />} onClick={openNew}>
          新建纸张
        </Button>
      ),
    )
    return () => onActions?.(null)
  }, [onActions, openNew, compact])

  const builtins = (papers.data ?? []).filter((p) => p.builtin)
  const mine = (papers.data ?? []).filter((p) => !p.builtin)

  const recentIds = React.useMemo(() => recentPaperIds(3), [])
  const recent = recentIds.map((id) => (papers.data ?? []).find((p) => p.id === id)).filter((p): p is PaperSpec => !!p)
  const missingCommon = COMMON_PAPERS.filter((c) => !(papers.data ?? []).some((p) => p.name === c.name))
  const [adding, setAdding] = React.useState<string | null>(null)

  const addCommon = async (list: PaperBase[]) => {
    setAdding(list.length > 1 ? '*' : list[0].name)
    try {
      for (const c of list) await save.mutateAsync({ body: c })
      toast.success(list.length > 1 ? `已添加 ${list.length} 种常用纸张` : `已添加「${list[0].name}」`)
    } catch {
      /* toasted */
    } finally {
      setAdding(null)
    }
  }

  const remove = async (p: PaperSpec) => {
    const ok = await del.mutateAsync(p.id).then(() => true).catch(() => false)
    if (!ok) return
    const { id: _id, builtin: _b, ...body } = p
    toast({
      title: `已删除「${p.name}」`,
      description: '用到它的项目会改用默认纸张。',
      duration: 10_000,
      action: { label: '撤销', onClick: () => void save.mutateAsync({ body }).then(() => toast.success(`已恢复「${p.name}」`)).catch(() => null) },
    })
  }

  const row = (p: PaperSpec) => (
    <div key={p.id} className="flex min-h-14 items-center gap-3 py-1.5 pl-3 pr-2">
      <PaperPreview paper={p} />
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-1.5 truncate text-body text-label">
          {p.name}
          {p.orientation === 'landscape' ? <span className="text-footnote text-secondary-label">横向</span> : null}
        </p>
        <p className="truncate text-footnote text-secondary-label tabular-nums">{paperSubtitle(p)}</p>
      </div>
      {p.builtin ? (
        <span className="flex items-center gap-1 pr-2 text-footnote text-tertiary-label" title="内置纸张不可修改">
          <Lock className="size-3.5" aria-hidden />
          <span className="sr-only">内置，只读</span>
        </span>
      ) : (
        <>
          <IconButton label={`编辑「${p.name}」`} onClick={() => { setEditing(p); setOpen(true) }}>
            <Pencil />
          </IconButton>
          <IconButton label={`删除「${p.name}」`} onClick={() => void remove(p)} className="hover:text-red">
            <Trash2 />
          </IconButton>
        </>
      )}
    </div>
  )

  return (
    <div className="flex flex-col gap-6">
      <SectionIntro description={<>纸张决定页面尺寸、边距和信笺行格，在创作台选纸张时可以直接使用。<HelpLink topic="paper" className="ml-1" /></>} />
      {papers.isPending ? (
        <SkeletonList rows={5} />
      ) : papers.isError ? (
        <QueryError error={papers.error} onRetry={() => void papers.refetch()} what="纸张预设" />
      ) : (
        <>
          {recent.length ? (
            <GroupedList header="最近使用">{recent.map((p) => row(p))}</GroupedList>
          ) : null}
          <GroupedList header="我的纸张" footer={mine.length ? undefined : null}>
            {mine.length ? (
              mine.map(row)
            ) : (
              <div className="flex flex-col items-center gap-2 px-4 py-6 text-center">
                <p className="text-callout text-secondary-label">还没有自定义纸张</p>
                <Button variant="tinted" size="sm" icon={<Plus />} onClick={openNew}>
                  新建纸张
                </Button>
              </div>
            )}
          </GroupedList>
          {missingCommon.length ? (
            <section className="flex flex-col">
              <div className="mb-1.5 flex items-end justify-between px-4">
                <h3 className="text-footnote font-medium text-secondary-label">常用纸张</h3>
                {missingCommon.length > 1 ? (
                  <Button size="sm" variant="plain" loading={adding === '*'} onClick={() => void addCommon(missingCommon)}>
                    全部添加
                  </Button>
                ) : null}
              </div>
              <GroupedList footer="一键添加到「我的纸张」，之后可以修改边距和行格。">
                {missingCommon.map((c) => (
                  <div key={c.name} className="flex min-h-14 items-center gap-3 py-1.5 pl-3 pr-3">
                    <PaperPreview paper={c} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-body text-label">{c.name}</p>
                      <p className="truncate text-footnote text-secondary-label tabular-nums">{fmtMM(dims(c).w)} × {fmtMM(dims(c).h)} mm</p>
                    </div>
                    <Button size="sm" variant="tinted" icon={<Plus />} loading={adding === c.name} disabled={!!adding} onClick={() => void addCommon([c])}>
                      添加
                    </Button>
                  </div>
                ))}
              </GroupedList>
            </section>
          ) : null}
          <GroupedList header="内置" footer="内置纸张为只读。需要不同边距时，可新建一张自定义纸张。">
            {builtins.map(row)}
          </GroupedList>
        </>
      )}
      <PaperDialog open={open} onOpenChange={setOpen} initial={editing} />
    </div>
  )
}
