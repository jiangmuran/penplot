import {
  AlignCenterHorizontal, AlignCenterVertical, AlignEndHorizontal, AlignEndVertical, AlignHorizontalDistributeCenter,
  AlignStartHorizontal, AlignStartVertical, AlignVerticalDistributeCenter, ArrowDownToLine, ArrowUpToLine, ChevronDown,
  ChevronUp, Eye, EyeOff, Link2, Link2Off, Lock, LockOpen, Maximize, Trash2,
} from 'lucide-react'
import type { Element, PaperBase } from '@/api/studio'
import { Button, IconButton, NumberField } from '@/components/ui'
import { align, deleteSelection, distribute, elementAABB, lastKeys, toggleHidden, toggleLock, zOrder } from '../actions'
import { corners, frameBox, localBox, scaleOf, aabb } from '../geometry'
import { fromUnit, paperDims, toUnit } from '../model'
import { useRender } from '../render-engine'
import { studio, useStudio } from '../store'
import { Row, Section } from './controls'
import * as React from 'react'

const r3 = (v: number) => Math.round(v * 1000) / 1000

function rendered(el: Element) {
  const k = lastKeys.get(el.id)
  return k ? useRender.getState().els[k]?.bbox ?? null : null
}

/** Element resized so its frame becomes fw × fh mm (frame origin kept). */
export function resized(el: Element, paper: PaperBase, fw: number, fh: number): Element {
  const t = el.transform
  const lb = localBox(el, paper, rendered(el))
  const f0 = frameBox(t, lb)
  const { sx: Sx, sy: Sy } = scaleOf(t)
  fw = Math.max(0.5, fw)
  fh = Math.max(0.01, fh)
  if (el.type === 'text') return { ...el, props: { ...el.props, box: { w: r3(fw / Sx), h: r3(fh / Sy) } } }
  if (el.type === 'shape') {
    const p = el.props
    if ((p.kind === 'line' || p.kind === 'polygon') && p.points?.length) {
      const kx = fw / Math.max(1e-6, f0.w)
      const ky = f0.h < 0.01 ? 1 : fh / Math.max(1e-6, f0.h)
      return { ...el, props: { ...p, points: p.points.map((q) => [r3(lb.x + (q[0] - lb.x) * kx), r3(lb.y + (q[1] - lb.y) * ky)]), w: r3(lb.w * kx), h: r3(lb.h * ky) } }
    }
    return { ...el, props: { ...p, w: r3(fw / Sx), h: r3(fh / Sy) } }
  }
  if (el.type === 'flow_text') return el
  const sc = t.scale || 1
  let nsx = fw / Math.max(1e-6, lb.w)
  let nsy = fh / Math.max(1e-6, lb.h)
  if (el.type === 'gcode') nsy = nsx
  return { ...el, transform: { ...t, sx: r3(nsx / sc), sy: r3(nsy / sc) } }
}

export function fitToMargins(el: Element, paper: PaperBase): Element {
  const { w, h } = paperDims(paper)
  const m = paper.margins
  const box = { x: m.l, y: m.t, w: w - m.l - m.r, h: h - m.t - m.b }
  const lb = localBox(el, paper, rendered(el))
  const f = frameBox(el.transform, lb)
  const ab0 = aabb(corners(el.transform, lb))
  const k = Math.min(box.w / Math.max(1e-6, ab0.w), box.h / Math.max(1e-6, ab0.h))
  let out = resized(el, paper, f.w * k, f.h * k)
  const ab = aabb(corners(out.transform, localBox(out, paper, null)))
  out = { ...out, transform: { ...out.transform, x: r3(out.transform.x + box.x + box.w / 2 - (ab.x + ab.w / 2)), y: r3(out.transform.y + box.y + box.h / 2 - (ab.y + ab.h / 2)) } }
  return out
}

export function ArrangeSection({ els, paper }: { els: Element[]; paper: PaperBase }) {
  const unit = useStudio((s) => s.overlays.unit)
  const [lockAR, setLockAR] = React.useState(true)
  useRender((s) => s.els) // re-render when rendered bboxes arrive
  const single = els.length === 1 ? els[0] : null
  const u = (v: number) => r3(toUnit(v, unit))
  const step = unit === 'in' ? 0.01 : 0.1
  const prec = unit === 'in' ? 3 : 1
  const allLocked = els.every((e) => e.locked)
  const allHidden = els.every((e) => e.hidden)
  const ab = single ? elementAABB(single, paper) : null
  const lb = single ? localBox(single, paper, rendered(single)) : null
  const fb = single && lb ? frameBox(single.transform, lb) : null
  const pos = single && lb ? corners(single.transform, lb)[0] : null
  const canResize = !!single && single.type !== 'flow_text' && !single.locked
  const setPos = (axis: 'x' | 'y', v: number) => {
    if (!single || !pos) return
    const d = fromUnit(v, unit) - pos[axis]
    studio.updateElement(single.id, (e) => ({ ...e, transform: { ...e.transform, [axis]: r3(e.transform[axis] + d) } }))
  }
  const setSize = (axis: 'w' | 'h', v: number) => {
    if (!single || !fb) return
    const mm = fromUnit(v, unit)
    const ar = fb.h / Math.max(1e-6, fb.w)
    const keep = lockAR || single.type === 'gcode'
    const fw = axis === 'w' ? mm : keep && fb.h > 0.01 ? mm / ar : fb.w
    const fh = axis === 'h' ? mm : keep ? mm * ar : fb.h
    studio.updateElement(single.id, (e) => resized(e, paper, fw, fh))
  }
  return (
    <Section
      title={single ? '排列' : `排列 · 已选 ${els.length} 个`}
      actions={
        <button type="button" className="press rounded-xs px-1 text-caption text-accent" onClick={() => useStudio.getState().setOverlay('unit', unit === 'mm' ? 'in' : 'mm')} aria-label="切换单位">
          {unit === 'mm' ? 'mm' : 'in'}
        </button>
      }
    >
      {single && pos && fb ? (
        <>
          <div className="grid grid-cols-[1fr_1fr] gap-1.5 px-1">
            <Field label="X" value={u(pos.x)} onChange={(v) => setPos('x', v)} step={step} prec={prec} unit={unit} disabled={single.locked} />
            <Field label="Y" value={u(pos.y)} onChange={(v) => setPos('y', v)} step={step} prec={prec} unit={unit} disabled={single.locked} />
            <Field label="W" value={u(fb.w)} onChange={(v) => setSize('w', v)} step={step} prec={prec} unit={unit} disabled={!canResize} />
            <Field label="H" value={u(fb.h)} onChange={(v) => setSize('h', v)} step={step} prec={prec} unit={unit} disabled={!canResize || fb.h < 0.01} />
          </div>
          <Row label="旋转">
            <NumberField
              value={single.transform.rotation || 0}
              onChange={(v) => {
                // rotate around the frame centre
                const c = { x: fb.x + fb.w / 2, y: fb.y + fb.h / 2 }
                const rad = (d: number) => (d * Math.PI) / 180
                const r0 = single.transform.rotation || 0
                const wc = { x: single.transform.x + c.x * Math.cos(rad(r0)) - c.y * Math.sin(rad(r0)), y: single.transform.y + c.x * Math.sin(rad(r0)) + c.y * Math.cos(rad(r0)) }
                const nx = wc.x - (c.x * Math.cos(rad(v)) - c.y * Math.sin(rad(v)))
                const ny = wc.y - (c.x * Math.sin(rad(v)) + c.y * Math.cos(rad(v)))
                studio.updateElement(single.id, (e) => ({ ...e, transform: { ...e.transform, rotation: v, x: r3(nx), y: r3(ny) } }))
              }}
              unit="°"
              step={1}
              min={-360}
              max={360}
              disabled={single.locked || single.type === 'flow_text'}
              className="min-w-0 flex-1"
              aria-label="旋转角度"
            />
            <IconButton label={lockAR ? '已锁定比例' : '锁定比例'} active={lockAR} onClick={() => setLockAR(!lockAR)} size="sm">
              {lockAR ? <Link2 /> : <Link2Off />}
            </IconButton>
          </Row>
          {canResize ? (
            <Button size="sm" variant="gray" icon={<Maximize />} className="mx-1" onClick={() => studio.updateElement(single.id, (e) => fitToMargins(e, paper))}>
              缩放至版心
            </Button>
          ) : null}
          {ab ? (
            <p className="px-1 text-footnote tabular-nums text-secondary-label">
              距纸边 左 {u(ab.x).toFixed(prec)} · 上 {u(ab.y).toFixed(prec)} · 右 {u(paperDims(paper).w - ab.x - ab.w).toFixed(prec)} · 下 {u(paperDims(paper).h - ab.y - ab.h).toFixed(prec)} {unit}
            </p>
          ) : null}
        </>
      ) : null}
      <div className="flex flex-wrap items-center gap-0.5 px-0.5">
        <IconButton label={els.length > 1 ? '左对齐' : '版心左对齐'} size="sm" onClick={() => align('left')}><AlignStartVertical /></IconButton>
        <IconButton label="水平居中" size="sm" onClick={() => align('hcenter')}><AlignCenterVertical /></IconButton>
        <IconButton label="右对齐" size="sm" onClick={() => align('right')}><AlignEndVertical /></IconButton>
        <IconButton label="顶对齐" size="sm" onClick={() => align('top')}><AlignStartHorizontal /></IconButton>
        <IconButton label="垂直居中" size="sm" onClick={() => align('vcenter')}><AlignCenterHorizontal /></IconButton>
        <IconButton label="底对齐" size="sm" onClick={() => align('bottom')}><AlignEndHorizontal /></IconButton>
        {els.length > 2 ? (
          <>
            <IconButton label="水平等距分布" size="sm" onClick={() => distribute('x')}><AlignHorizontalDistributeCenter /></IconButton>
            <IconButton label="垂直等距分布" size="sm" onClick={() => distribute('y')}><AlignVerticalDistributeCenter /></IconButton>
          </>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-0.5 px-0.5">
        <IconButton label="置于顶层" shortcut="mod+shift+]" size="sm" onClick={() => zOrder('top')}><ArrowUpToLine /></IconButton>
        <IconButton label="上移一层" shortcut="mod+]" size="sm" onClick={() => zOrder('up')}><ChevronUp /></IconButton>
        <IconButton label="下移一层" shortcut="mod+[" size="sm" onClick={() => zOrder('down')}><ChevronDown /></IconButton>
        <IconButton label="置于底层" shortcut="mod+shift+[" size="sm" onClick={() => zOrder('bottom')}><ArrowDownToLine /></IconButton>
        <span className="mx-1 h-4 w-px bg-separator" />
        <IconButton label={allLocked ? '解锁' : '锁定'} shortcut="mod+shift+l" size="sm" active={allLocked} onClick={() => toggleLock(els.map((e) => e.id))}>
          {allLocked ? <Lock /> : <LockOpen />}
        </IconButton>
        <IconButton label={allHidden ? '显示（打印）' : '隐藏（不打印）'} size="sm" active={allHidden} onClick={() => toggleHidden(els.map((e) => e.id))}>
          {allHidden ? <EyeOff /> : <Eye />}
        </IconButton>
        <IconButton label="删除" shortcut="delete" size="sm" className="hover:text-red" onClick={deleteSelection}><Trash2 /></IconButton>
      </div>
    </Section>
  )
}

function Field({ label, value, onChange, step, prec, unit, disabled }: { label: string; value: number; onChange: (v: number) => void; step: number; prec: number; unit: string; disabled?: boolean }) {
  return (
    <label className="flex min-w-0 items-center gap-1">
      <span className="w-3.5 shrink-0 text-center text-footnote font-medium text-secondary-label">{label}</span>
      <NumberField value={value} onChange={onChange} step={step} precision={prec} unit={unit} stepper={false} disabled={disabled} className="min-w-0 flex-1" aria-label={label} />
    </label>
  )
}
