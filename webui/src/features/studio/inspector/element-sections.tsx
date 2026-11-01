import { FileCode2, Info } from 'lucide-react'
import type { DxfElement, GcodeElement, ImageElement, ShapeElement, SvgElement } from '@/api/studio'
import { cn } from '@/lib/cn'
import { formatNumber } from '@/lib/format'
import { useElementRender } from '../canvas/element-view'
import { studio, useStudio } from '../store'
import { Note, Num, Row, Section, SegRow, SliderRow, SwitchRow } from './controls'

export function ImageSection({ el }: { el: ImageElement }) {
  const p = el.props
  const set = (patch: Record<string, unknown>) => studio.setProps(el.id, patch, 'trace')
  const showSource = useStudio((s) => s.overlays.source)
  const { r } = useElementRender(el)
  return (
    <Section title="转换为路径">
      <div className="grid grid-cols-3 gap-1.5 px-1">
        {([
          ['edge', '线稿轮廓', '描出边缘'],
          ['skeleton', '单线骨架', '适合线条画'],
          ['dots', '点画', '明暗用点表示'],
        ] as const).map(([m, label, sub]) => (
          <button
            key={m}
            type="button"
            onClick={() => set({ mode: m })}
            aria-pressed={p.mode === m}
            className={cn('press focus-ring flex flex-col items-center gap-0.5 rounded-lg px-1 py-2 text-center', p.mode === m ? 'bg-accent/12 ring-2 ring-accent' : 'bg-fill/50 hover:bg-fill')}
          >
            <span className="text-footnote font-semibold text-label">{label}</span>
            <span className="text-footnote text-secondary-label">{sub}</span>
          </button>
        ))}
      </div>
      <SliderRow label="细节" value={detailOf(p)} onChange={(d) => set(detailPatch(p.mode, d))} min={0} max={1} step={0.05} />
      <details className="group px-1">
        <summary className="flex cursor-default list-none items-center gap-1 py-1 text-footnote font-medium text-accent [&::-webkit-details-marker]:hidden">
          <span className="transition-transform group-open:rotate-90">›</span> 高级参数
        </summary>
        <div className="-mx-1 flex flex-col gap-1.5 pt-1">
      {p.mode === 'edge' ? (
        <>
          <SliderRow label="模糊" value={p.blur} onChange={(v) => set({ blur: v })} min={0} max={5} step={0.1} />
          <SliderRow label="低阈值" value={p.th_low} onChange={(v) => set({ th_low: Math.min(v, p.th_high) })} min={0} max={1} step={0.01} />
          <SliderRow label="高阈值" value={p.th_high} onChange={(v) => set({ th_high: Math.max(v, p.th_low) })} min={0} max={1} step={0.01} />
        </>
      ) : null}
      {p.mode === 'skeleton' ? <SliderRow label="二值化" value={p.binarize} onChange={(v) => set({ binarize: v })} min={0} max={1} step={0.01} /> : null}
      {p.mode === 'dots' ? (
        <>
          <SliderRow label="点距" value={p.spacing_mm} onChange={(v) => set({ spacing_mm: v })} min={0.3} max={5} step={0.1} unit="mm" />
          <SliderRow label="Gamma" value={p.gamma} onChange={(v) => set({ gamma: v })} min={0.2} max={3} step={0.05} />
        </>
      ) : (
        <>
          <SliderRow label="简化" value={p.simplify} onChange={(v) => set({ simplify: v })} min={0} max={3} step={0.1} unit="px" />
          <Num label="最短线段" value={p.min_len} onChange={(v) => set({ min_len: Math.round(v) })} step={1} min={1} max={200} unit="点" />
        </>
      )}
      <Num label="描摹宽度" value={p.width_mm} onChange={(v) => set({ width_mm: v })} unit="mm" step={1} min={5} max={600} hint="改变会重新描摹" />
      <Num label="最大像素" value={p.max_px} onChange={(v) => set({ max_px: Math.round(v) })} step={100} min={200} max={4000} unit="px" />
        </div>
      </details>
      <SwitchRow label="反相" checked={p.invert} onChange={(v) => set({ invert: v })} />
      <SwitchRow label="显示原图" checked={showSource} onChange={(v) => useStudio.getState().setOverlay('source', v)} hint="原图 ◀▶ 路径" />
      {r?.status === 'ok' ? (
        <Note tone={(r.strokes ?? 0) > 3000 ? 'orange' : 'gray'}>
          约 {(r.strokes ?? 0).toLocaleString('zh-CN')} 笔{(r.strokes ?? 0) > 3000 ? '，会写很久，可以把「细节」调低一些。' : ''}
        </Note>
      ) : r?.status === 'pending' ? (
        <Note>正在描摹…</Note>
      ) : null}
      {r?.status === 'error' ? <Note tone="red">{r.error}</Note> : null}
    </Section>
  )
}

type IP = ImageElement['props']
function detailOf(p: IP): number {
  const c = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 20) / 20
  if (p.mode === 'dots') return c((3 - p.spacing_mm) / 2.5)
  if (p.mode === 'skeleton') return c((2 - p.simplify) / 1.8)
  return c((0.5 - p.th_high) / 0.4)
}
function detailPatch(mode: IP['mode'], d: number): Partial<IP> {
  if (mode === 'dots') return { spacing_mm: Math.round((3 - 2.5 * d) * 100) / 100 }
  if (mode === 'skeleton') return { simplify: Math.round((2 - 1.8 * d) * 100) / 100 }
  const hi = Math.round((0.5 - 0.4 * d) * 100) / 100
  return { th_high: hi, th_low: Math.round(hi * 0.4 * 100) / 100 }
}

export function VectorSection({ el }: { el: SvgElement | DxfElement }) {
  const p = el.props as SvgElement['props'] & { native_w?: number; native_h?: number; file_name?: string }
  const set = (patch: Record<string, unknown>) => studio.setProps(el.id, patch, 'vec')
  const { r } = useElementRender(el)
  return (
    <Section title={el.type === 'svg' ? 'SVG 矢量' : 'DXF 矢量'}>
      <Row label="文件">
        <span className="truncate text-footnote text-secondary-label">{p.file_name ?? p.file_id}</span>
      </Row>
      {p.native_w ? (
        <Row label="原始尺寸">
          <span className="text-footnote tabular-nums text-secondary-label">
            {formatNumber(p.native_w, 1)} × {formatNumber(p.native_h, 1)} mm
          </span>
        </Row>
      ) : null}
      <Num label="宽度" value={p.width_mm ?? p.native_w ?? null} onChange={(v) => set({ width_mm: v })} unit="mm" step={1} min={1} max={2000} hint="重新展平" />
      <SliderRow label="展平精度" value={p.flatten_tol_mm} onChange={(v) => set({ flatten_tol_mm: v })} min={0.01} max={1} step={0.01} unit="mm" />
      {r?.status === 'ok' ? <p className="px-1 text-caption tabular-nums text-tertiary-label">{r.strokes ?? 0} 条路径 · 仅描边（填充不绘制）</p> : null}
    </Section>
  )
}

export function ShapeSection({ el }: { el: ShapeElement }) {
  const p = el.props
  const set = (patch: Record<string, unknown>) => studio.setProps(el.id, patch, 'shape')
  return (
    <Section title="形状">
      <SegRow
        label="类型"
        value={p.kind}
        onChange={(v) => set({ kind: v, points: v === 'line' ? [[0, 0], [p.w || 40, 0]] : v === 'polygon' ? [[p.w / 2, 0], [p.w, p.h], [0, p.h]] : p.points })}
        options={[{ value: 'rect', label: '矩形' }, { value: 'ellipse', label: '椭圆' }, { value: 'line', label: '线' }, { value: 'grid', label: '格' }]}
      />
      {p.kind === 'grid' ? (
        <>
          <Num label="行" value={p.rows} onChange={(v) => set({ rows: Math.max(1, Math.round(v)) })} step={1} min={1} max={60} />
          <Num label="列" value={p.cols} onChange={(v) => set({ cols: Math.max(1, Math.round(v)) })} step={1} min={1} max={60} />
          <SegRow label="格式" value={p.grid_style} onChange={(v) => set({ grid_style: v })} options={[{ value: 'plain', label: '方格' }, { value: 'tian', label: '田字' }, { value: 'mi', label: '米字' }]} />
        </>
      ) : null}
      {p.kind === 'rect' || p.kind === 'ellipse' ? (
        <>
          <SwitchRow label="排线填充" checked={!!p.hatch} onChange={(v) => set({ hatch: v ? { angle: 45, spacing: 2 } : null })} />
          {p.hatch ? (
            <>
              <SliderRow label="角度" value={p.hatch.angle} onChange={(v) => set({ hatch: { ...p.hatch!, angle: v } })} min={0} max={180} step={1} unit="°" />
              <SliderRow label="间距" value={p.hatch.spacing} onChange={(v) => set({ hatch: { ...p.hatch!, spacing: v } })} min={0.3} max={10} step={0.1} unit="mm" />
            </>
          ) : null}
        </>
      ) : null}
    </Section>
  )
}

export function GcodeSection({ el }: { el: GcodeElement }) {
  const p = el.props as GcodeElement['props'] & { native_w?: number; native_h?: number; file_name?: string }
  const { r } = useElementRender(el)
  return (
    <Section title="G 代码">
      <Row label="文件">
        <span className="flex min-w-0 items-center gap-1 truncate text-footnote text-secondary-label">
          <FileCode2 className="size-3.5 shrink-0" />
          {p.file_name ?? p.file_id}
        </span>
      </Row>
      {p.native_w ? (
        <Row label="范围">
          <span className="text-footnote tabular-nums text-secondary-label">
            {formatNumber(p.native_w, 1)} × {formatNumber(p.native_h, 1)} mm
          </span>
        </Row>
      ) : null}
      {r?.status === 'ok' ? <p className="px-1 text-caption tabular-nums text-tertiary-label">{r.strokes ?? 0} 条路径</p> : null}
      <Note tone="blue" icon={<Info />}>
        G 代码会按当前机器配置重新生成；只能平移、旋转与等比缩放。
      </Note>
    </Section>
  )
}
