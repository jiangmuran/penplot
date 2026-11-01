import { ArrowLeftRight, Crosshair, FileText, Plus, RotateCcw, Trash2 } from 'lucide-react'
import type { OriginSpec, PaperBase, Variable } from '@/api/studio'
import { Button, IconButton, Input, Segmented } from '@/components/ui'
import { cn } from '@/lib/cn'
import { DEFAULT_ORIGIN, machineAxes, originAnchor, paperDims, usedVariables } from '../model'
import { useStudio } from '../store'
import { Note, Num, Row, Section, SwitchRow } from './controls'

export function PaperCard({ paper, onOpen, pageOverride }: { paper: PaperBase; onOpen: () => void; pageOverride: boolean }) {
  const { w, h } = paperDims(paper)
  const k = 56 / Math.max(w, h)
  return (
    <button type="button" onClick={onOpen} className="press focus-ring mx-1 flex w-[calc(100%-8px)] items-center gap-3 rounded-lg bg-fill/50 p-2.5 text-left hover:bg-fill">
      <span className="flex size-16 shrink-0 items-center justify-center">
        <span className="relative bg-canvas-paper shadow-paper" style={{ width: w * k, height: h * k }}>
          <span
            className="absolute border border-dashed border-gray/60"
            style={{ left: paper.margins.l * k, top: paper.margins.t * k, right: paper.margins.r * k, bottom: paper.margins.b * k }}
          />
        </span>
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-headline text-label">{paper.name || '自定义'}</span>
        <span className="block text-footnote tabular-nums text-secondary-label">
          {w} × {h} mm · {paper.orientation === 'landscape' ? '横向' : '纵向'}
        </span>
        <span className="block text-footnote tabular-nums text-secondary-label">
          边距 {paper.margins.t === paper.margins.b && paper.margins.l === paper.margins.r ? `上下 ${paper.margins.t} · 左右 ${paper.margins.l}` : `${paper.margins.t}/${paper.margins.r}/${paper.margins.b}/${paper.margins.l}`} mm
          {pageOverride ? ' · 本页单独设置' : ''}
        </span>
      </span>
      <span className="text-footnote text-accent">更改…</span>
    </button>
  )
}

const CORNERS: { c: OriginSpec['corner']; x: number; y: number; label: string }[] = [
  { c: 0, x: 0, y: 0, label: '左上' },
  { c: 1, x: 1, y: 0, label: '右上' },
  { c: 2, x: 0, y: 1, label: '左下' },
  { c: 3, x: 1, y: 1, label: '右下' },
]

/** Four-corner origin picker on a paper thumbnail, with live axis arrows. */
export function CornerPicker({ origin, onChange, paper }: { origin: OriginSpec; onChange: (o: OriginSpec) => void; paper: PaperBase }) {
  const { w, h } = paperDims(paper)
  const W = 132
  const H = Math.max(80, Math.min(170, (W * h) / w))
  const ax = machineAxes(origin)
  const cur = CORNERS.find((c) => c.c === origin.corner)!
  const content = originAnchor(origin) === 'content'
  // content anchor: the corners are those of the drawing (a dashed box inside the paper)
  const ix = content ? W * 0.2 : 0
  const iy = content ? H * 0.22 : 0
  const px = (fx: number) => ix + fx * (W - 2 * ix)
  const py = (fy: number) => iy + fy * (H - 2 * iy)
  const ox = px(cur.x)
  const oy = py(cur.y)
  const L = 34
  return (
    <div className="flex items-start gap-3 px-1">
      <div className="relative shrink-0" style={{ width: W + 24, height: H + 24 }}>
        <svg width={W + 24} height={H + 24} className="absolute inset-0" aria-hidden>
          <g transform="translate(12 12)">
            <rect width={W} height={H} rx={2} fill="rgb(var(--canvas-paper))" stroke="rgb(var(--separator) / var(--separator-a))" />
            {content ? (
              <>
                <rect x={ix} y={iy} width={W - 2 * ix} height={H - 2 * iy} fill="rgb(var(--accent) / 0.06)" stroke="rgb(var(--axis-origin))" strokeDasharray="3 2" />
                {[0, 1, 2].map((i) => (
                  <line key={i} x1={ix + 6} x2={W - ix - 6 - i * 10} y1={iy + 8 + i * 9} y2={iy + 8 + i * 9} stroke="rgb(var(--secondary-label) / 0.35)" strokeWidth={2} strokeLinecap="round" />
                ))}
              </>
            ) : null}
            <g transform={`translate(${ox} ${oy})`}>
              <g style={{ transform: `rotate(${(Math.atan2(ax.x.y, ax.x.x) * 180) / Math.PI}deg)`, transition: 'transform var(--dur-base) var(--ease-standard)' }}>
                <line x1={0} y1={0} x2={L - 5} y2={0} stroke="rgb(var(--axis-x))" strokeWidth={2} />
                <path d={`M${L} 0 l-6 -3.5 v7 z`} fill="rgb(var(--axis-x))" />
              </g>
              <g style={{ transform: `rotate(${(Math.atan2(ax.y.y, ax.y.x) * 180) / Math.PI}deg)`, transition: 'transform var(--dur-base) var(--ease-standard)' }}>
                <line x1={0} y1={0} x2={L - 5} y2={0} stroke="rgb(var(--axis-y))" strokeWidth={2} />
                <path d={`M${L} 0 l-6 -3.5 v7 z`} fill="rgb(var(--axis-y))" />
              </g>
            </g>
          </g>
        </svg>
        {CORNERS.map((c) => (
          <button
            key={c.c}
            type="button"
            aria-label={`原点在${content ? '内容' : '纸张'}${c.label}角`}
            aria-pressed={origin.corner === c.c}
            onClick={() => onChange({ ...origin, corner: c.c })}
            className={cn(
              'focus-ring absolute flex size-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full pointer-coarse:size-11',
            )}
            style={{ left: 12 + px(c.x), top: 12 + py(c.y) }}
          >
            <span className={cn('size-3.5 rounded-full border-2 transition-colors', origin.corner === c.c ? 'border-accent bg-accent' : 'border-gray bg-bg-elevated hover:border-accent')} />
          </button>
        ))}
      </div>
      <div className="flex min-w-0 flex-col gap-1 pt-2 text-caption text-secondary-label">
        <span className="flex items-center gap-1"><span className="h-0.5 w-3 rounded bg-axis-x" />+X 方向</span>
        <span className="flex items-center gap-1"><span className="h-0.5 w-3 rounded bg-axis-y" />+Y 方向</span>
        <span className="mt-1 text-tertiary-label">
          {content ? '开始前把笔（抬起）停在要写内容的这个角。点选四角切换。' : '开始前把笔（抬起）停在纸张的这个角。点选四角切换。'}
        </span>
      </div>
    </div>
  )
}

export function OriginSection({ origin, overridden, paper, profileName, onOpenPosition }: {
  origin: OriginSpec
  overridden: boolean
  paper: PaperBase
  profileName: string
  onOpenPosition: () => void
}) {
  const setOrigin = (o: OriginSpec | null) =>
    useStudio.getState().edit((d) => {
      d.print = { ...d.print, origin: o }
    }, { coalesce: 'origin' })
  const base = origin ?? DEFAULT_ORIGIN
  const set = (patch: Partial<OriginSpec>) => setOrigin({ ...base, ...patch })
  return (
    <Section
      title="原点与坐标"
      actions={
        overridden ? (
          <button type="button" className="press flex items-center gap-1 text-caption text-accent" onClick={() => setOrigin(null)}>
            <RotateCcw className="size-3" /> 恢复机器配置
          </button>
        ) : null
      }
    >
      <p className="flex items-center gap-1.5 px-1 text-caption text-secondary-label">
        来自机器配置「{profileName}」
        {overridden ? (
          <span className="flex items-center gap-1 text-on-tint-orange">
            · 本项目已覆盖 <span className="size-1.5 rounded-full bg-overridden" aria-label="已覆盖" />
          </span>
        ) : null}
      </p>
      <Segmented<'content' | 'paper'>
        size="sm"
        block
        aria-label="原点对齐"
        value={originAnchor(base)}
        onValueChange={(a) => set({ anchor: a })}
        options={[
          { value: 'content', label: `内容${CORNERS[base.corner].label}角` },
          { value: 'paper', label: `纸张${CORNERS[base.corner].label}角` },
        ]}
        className="mx-1"
      />
      <CornerPicker origin={base} onChange={setOrigin} paper={paper} />
      <Row label="交换 XY">
        <Button size="sm" variant={base.revxy ? 'tinted' : 'gray'} icon={<ArrowLeftRight />} onClick={() => set({ revxy: !base.revxy })} aria-pressed={base.revxy}>
          {base.revxy ? '已交换' : '交换'}
        </Button>
      </Row>
      <SwitchRow label="X 反向" checked={base.x_rev} onChange={(v) => set({ x_rev: v })} />
      <SwitchRow label="Y 反向" checked={base.y_rev} onChange={(v) => set({ y_rev: v })} />
      <Num label="偏移 X" value={base.offset_x_mm} onChange={(v) => set({ offset_x_mm: v })} unit="mm" step={0.5} min={-500} max={500} hint={originAnchor(base) === 'content' ? '自内容的角向内' : '自纸张的角向内'} />
      <Num label="偏移 Y" value={base.offset_y_mm} onChange={(v) => set({ offset_y_mm: v })} unit="mm" step={0.5} min={-500} max={500} />
      <Button size="sm" variant="gray" icon={<Crosshair />} className="mx-1" onClick={onOpenPosition}>
        位置预览…
      </Button>
    </Section>
  )
}

export function VariablesSection() {
  const doc = useStudio((s) => s.doc)
  if (!doc) return null
  const used = usedVariables(doc)
  const vars = doc.variables ?? []
  const missing = used.filter((u) => !vars.some((v) => v.name === u))
  const update = (fn: (v: Variable[]) => Variable[]) =>
    useStudio.getState().edit((d) => {
      d.variables = fn(d.variables ?? [])
    }, { coalesce: 'vars' })
  return (
    <Section
      title="数据 · 变量"
      actions={
        <IconButton label="添加变量" size="sm" onClick={() => update((v) => [...v, { name: `var${v.length + 1}`, default: '', type: 'text', label: null }])}>
          <Plus />
        </IconButton>
      }
    >
      {vars.length === 0 && missing.length === 0 ? (
        <p className="px-1 text-footnote text-secondary-label">在文本中写 {'{{姓名}}'} 即可引用变量；默认值用于预览和单份打印。</p>
      ) : null}
      {vars.map((v, i) => (
        <div key={i} className="flex items-center gap-1.5 px-1">
          <Input value={v.name} onChange={(e) => { const name = e.currentTarget.value; update((l) => l.map((x, j) => (j === i ? { ...x, name } : x))) }} className="w-24" aria-label="变量名" />
          <Input value={v.default} onChange={(e) => { const val = e.currentTarget.value; update((l) => l.map((x, j) => (j === i ? { ...x, default: val } : x))) }} placeholder="默认值" className="min-w-0 flex-1" aria-label={`${v.name} 默认值`} />
          <IconButton label="删除变量" size="sm" onClick={() => update((l) => l.filter((_, j) => j !== i))}>
            <Trash2 />
          </IconButton>
        </div>
      ))}
      {missing.length ? (
        <Note tone="orange">
          未定义：{missing.map((m) => `{{${m}}}`).join(' ')}{' '}
          <button type="button" className="text-accent underline-offset-2 hover:underline" onClick={() => update((v) => [...v, ...missing.map((name) => ({ name, default: '', type: 'text' as const, label: null }))])}>
            全部添加
          </button>
        </Note>
      ) : null}
    </Section>
  )
}

export function LetterSection({ onSelectFlow }: { onSelectFlow: () => void }) {
  return (
    <Section title="信笺">
      <p className="px-1 text-footnote text-secondary-label">正文在版心内按纸张行数自动分页，超出的内容生成「自动」页。</p>
      <Button size="sm" variant="gray" icon={<FileText />} className="mx-1" onClick={onSelectFlow}>
        编辑正文…
      </Button>
    </Section>
  )
}

