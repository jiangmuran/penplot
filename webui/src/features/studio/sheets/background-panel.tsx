/**
 * Reference background UI: the inspector section (纸张 group), the floating 对齐背景 panel shown over the canvas in
 * align mode (size / two-point calibration / rotation / position / display), and the PDF page picker.
 * The background is a reference only — never drawn, printed or exported to G-code.
 */
import {
  ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Check, Eye, EyeOff, FileImage, ImagePlus, Lock, LockOpen, Maximize2, Ruler,
  RotateCcw, RotateCw, Trash2, X,
} from 'lucide-react'
import * as React from 'react'
import { create } from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import { BACKGROUND_ACCEPT, fileContentUrl, pdfThumbUrl } from '@/api/studio-background'
import { Button, Dialog, DialogBody, DialogContent, DialogHeader, DialogTitle, IconButton, NumberField, Segmented, Slider, Switch } from '@/components/ui'
import { cn } from '@/lib/cn'
import { confirm } from '@/lib/confirm'
import { useCoarsePointer, useIsCompact } from '@/lib/media'
import { currentPaper } from '../actions'
import {
  bgSize, calibrate, fitToPaper, normDeg, patchBackground, removeBackground, setBackgroundFromFile, setBackgroundPage,
  withWidth, type PageBackground,
} from '../background'
import { Note, Row, Section } from '../inspector/controls'
import { paperDims } from '../model'
import { useStudio } from '../store'

/** Open a native file picker (must be called from a click). */
export function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = accept
    input.style.display = 'none'
    input.onchange = () => {
      resolve(input.files?.[0] ?? null)
      input.remove()
    }
    input.oncancel = () => {
      resolve(null)
      input.remove()
    }
    document.body.appendChild(input)
    input.click()
  })
}

const usePagesDialog = create<{ open: boolean; set: (o: boolean) => void }>((set) => ({ open: false, set: (open) => set({ open }) }))

/** Pick a file and make it the current page's background (multi-page PDF → page picker). */
export async function importBackgroundInteractive(file?: File | null) {
  const f = file ?? (await pickFile(BACKGROUND_ACCEPT))
  if (!f) return
  const bg = await setBackgroundFromFile(f)
  if (bg && bg.page_count > 1) usePagesDialog.getState().set(true)
}

function useBg() {
  return useStudio((s) => s.doc?.pages[s.view.page]?.background ?? null)
}

// ------------------------------------------------------------------ inspector section

export function BackgroundSection() {
  const bg = useBg()
  const readOnly = useStudio((s) => s.readOnly)
  if (!bg) {
    return (
      <Section title="参考背景">
        <p className="px-1 text-footnote text-secondary-label">
          导入已有的笔记模板、信纸扫描件（图片或 PDF）垫在下面做参考，对齐后照着排版。背景<b className="font-semibold">不会被写出来</b>。
        </p>
        <Button size="sm" variant="gray" icon={<ImagePlus />} className="mx-1" disabled={readOnly} onClick={() => void importBackgroundInteractive()}>
          导入扫描件 / PDF…
        </Button>
      </Section>
    )
  }
  const { w, h } = bgSize(bg)
  return (
    <Section
      title="参考背景"
      actions={
        <span className="flex items-center gap-1 text-caption text-tertiary-label">
          <EyeOff className="size-3" /> 不打印
        </span>
      }
    >
      <div className="flex items-center gap-2.5 px-1">
        <span className="flex size-14 shrink-0 items-center justify-center overflow-hidden rounded-md bg-canvas-paper shadow-paper">
          <img src={fileContentUrl(bg.file_id)} alt="" className="max-h-full max-w-full object-contain" style={{ opacity: bg.visible ? 1 : 0.35 }} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-body text-label">{bg.name || '参考背景'}</span>
          <span className="block text-footnote tabular-nums text-secondary-label">
            {w.toFixed(1)} × {h.toFixed(1)} mm · {normDeg(bg.transform.rotation).toFixed(1)}°
          </span>
          {bg.page_count > 1 ? (
            <button type="button" className="text-footnote text-accent" onClick={() => usePagesDialog.getState().set(true)}>
              PDF 第 {bg.page + 1} / {bg.page_count} 页 · 换页…
            </button>
          ) : null}
        </span>
      </div>
      <Row label="显示">
        <span className="text-caption text-tertiary-label">快捷键 B</span>
        <Switch checked={bg.visible} onCheckedChange={(v) => patchBackground({ visible: v })} aria-label="显示参考背景" disabled={readOnly} />
      </Row>
      <Row label="不透明度">
        <Slider value={[Math.round(bg.opacity * 100)]} min={5} max={100} step={5} onValueChange={([x]) => patchBackground({ opacity: x / 100 }, { coalesce: 'opacity' })} className="min-w-0 flex-1" aria-label="背景不透明度" disabled={readOnly} />
        <span className="w-9 shrink-0 text-right text-footnote tabular-nums text-secondary-label">{Math.round(bg.opacity * 100)}%</span>
      </Row>
      <Row label="锁定">
        <Switch checked={bg.locked} onCheckedChange={(v) => patchBackground({ locked: v })} aria-label="锁定参考背景" disabled={readOnly} />
      </Row>
      <div className="flex flex-wrap gap-1.5 px-1 pt-1">
        <Button size="sm" variant="tinted" icon={<Ruler />} disabled={readOnly} onClick={() => useStudio.getState().setBgAlign(true)}>
          对齐背景…
        </Button>
        <Button size="sm" variant="gray" icon={<FileImage />} disabled={readOnly} onClick={() => void importBackgroundInteractive()}>
          更换
        </Button>
        <IconButton label="移除参考背景" size="sm" disabled={readOnly} onClick={() => void askRemove()}>
          <Trash2 />
        </IconButton>
      </div>
    </Section>
  )
}

async function askRemove() {
  if (await confirm({ title: '移除参考背景？', description: '只移除这一页的背景图，不影响排版内容。可以撤销。', confirmLabel: '移除', destructive: true })) removeBackground()
}

// ------------------------------------------------------------------ align panel

type Tab = 'size' | 'calib' | 'rotate' | 'move' | 'view'

export function BackgroundAlignPanel() {
  const bg = useBg()
  const compact = useIsCompact()
  const coarse = useCoarsePointer()
  const { calib, touchMode } = useStudio(useShallow((s) => ({ calib: s.bgCalib, touchMode: s.bgTouch })))
  const [tab, setTab] = React.useState<Tab>('size')
  React.useEffect(() => {
    if (calib) setTab('calib')
  }, [calib])
  if (!bg) return null
  const done = () => useStudio.getState().setBgAlign(false)
  const locked = bg.locked
  return (
    <div
      className={cn(
        'mat-thick pointer-events-auto absolute z-20 flex flex-col overflow-hidden rounded-xl shadow-lg ring-1 ring-separator/50',
        compact ? 'inset-x-2 bottom-2 max-h-[78%] bg-bg-elevated' : 'right-3 top-3 max-h-[calc(100%-88px)] w-[316px]',
      )}
      role="dialog"
      aria-label="对齐背景"
    >
      <div className="hairline-b flex shrink-0 items-center gap-2 px-3 py-2">
        <Ruler className="size-4 text-orange" />
        <h2 className="min-w-0 flex-1 truncate text-headline">对齐背景</h2>
        <IconButton label={bg.visible ? '隐藏背景' : '显示背景'} shortcut="b" size="sm" onClick={() => patchBackground({ visible: !bg.visible })}>
          {bg.visible ? <Eye /> : <EyeOff />}
        </IconButton>
        <IconButton label={locked ? '解锁' : '锁定'} size="sm" active={locked} onClick={() => patchBackground({ locked: !locked })}>
          {locked ? <Lock /> : <LockOpen />}
        </IconButton>
        <Button size="sm" variant="filled" icon={<Check />} onClick={done}>
          完成
        </Button>
      </div>
      <div className={cn('flex shrink-0 flex-col px-3 pt-2', compact ? 'gap-1.5' : 'gap-2')}>
        <p className={cn('text-footnote text-secondary-label', compact && !locked && 'hidden')}>
          {locked
            ? '背景已锁定，解锁后才能移动。'
            : coarse
              ? '单指拖动移动，双指捏合缩放、转动；接近 90° 自动吸附。'
              : '拖动移动 · 拖四角缩放 · 拖圆点旋转（Shift 15°）· 方向键微移。'}
        </p>
        {coarse ? (
          <Segmented
            size="sm"
            block
            value={touchMode}
            onValueChange={(v) => useStudio.getState().setBgTouch(v)}
            options={[{ value: 'bg', label: '手势移动背景' }, { value: 'view', label: '手势移动画布' }]}
            aria-label="手势作用于"
          />
        ) : null}
        <Segmented
          size="sm"
          block
          value={tab}
          onValueChange={setTab}
          options={[
            { value: 'size', label: '尺寸' },
            { value: 'calib', label: '两点' },
            { value: 'rotate', label: '旋转' },
            { value: 'move', label: '位置' },
            { value: 'view', label: '显示' },
          ]}
          aria-label="对齐方式"
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-3 pt-1">
        {tab === 'size' ? <SizeTab bg={bg} /> : null}
        {tab === 'calib' ? <CalibTab bg={bg} /> : null}
        {tab === 'rotate' ? <RotateTab bg={bg} /> : null}
        {tab === 'move' ? <MoveTab bg={bg} /> : null}
        {tab === 'view' ? <ViewTab bg={bg} /> : null}
      </div>
    </div>
  )
}

function SizeTab({ bg }: { bg: PageBackground }) {
  const { w, h } = bgSize(bg)
  const paper = currentPaper()
  const { w: pw, h: ph } = paperDims(paper)
  const dis = bg.locked
  return (
    <div className="flex flex-col gap-1.5 pt-1">
      <p className="px-1 text-footnote text-secondary-label">输入扫描件这张纸的真实尺寸（用尺子量），或者让它和纸张一样大。</p>
      <Row label="宽">
        <NumberField value={Math.round(w * 10) / 10} onChange={(v) => v > 0 && patchBackground({ transform: withWidth(bg, v) }, { coalesce: 'size' })} unit="mm" step={0.5} min={1} max={2000} disabled={dis} className="w-full" aria-label="背景宽度" />
      </Row>
      <Row label="高">
        <NumberField value={Math.round(h * 10) / 10} onChange={(v) => v > 0 && patchBackground({ transform: withWidth(bg, (v * bg.px_w) / bg.px_h) }, { coalesce: 'size' })} unit="mm" step={0.5} min={1} max={2000} disabled={dis} className="w-full" aria-label="背景高度" />
      </Row>
      <div className="flex flex-wrap gap-1.5 px-1 pt-1">
        <Button size="sm" variant="tinted" icon={<Maximize2 />} disabled={dis} onClick={() => patchBackground({ transform: fitToPaper(bg, pw, ph) })}>
          匹配纸张 {pw}×{ph}
        </Button>
        {bg.natural_mm ? (
          <Button size="sm" variant="gray" disabled={dis} onClick={() => patchBackground({ transform: { ...bg.transform, scale: bg.natural_mm![0] / bg.px_w } })}>
            文件原始尺寸 {bg.natural_mm[0].toFixed(0)}×{bg.natural_mm[1].toFixed(0)}
          </Button>
        ) : null}
      </div>
      {Math.abs(w / h - pw / ph) > 0.02 ? (
        <Note tone="gray">扫描件和纸张的长宽比不同（扫描时带了白边？）。用「两点」校准更准。</Note>
      ) : null}
    </div>
  )
}

function CalibTab({ bg }: { bg: PageBackground }) {
  const calib = useStudio((s) => s.bgCalib)
  const set = useStudio.getState().setBgCalib
  const measured = calib?.a && calib?.b ? Math.hypot(calib.b.x - calib.a.x, calib.b.y - calib.a.y) * bg.transform.scale : 0
  const [mm, setMm] = React.useState<number>(0)
  const [align, setAlign] = React.useState<'none' | 'h' | 'v'>('h')
  React.useEffect(() => {
    if (calib?.step !== 'dist' || !calib.a || !calib.b) return
    setMm(Math.round(measured * 10) / 10)
    const ang = normDeg((Math.atan2(calib.b.y - calib.a.y, calib.b.x - calib.a.x) * 180) / Math.PI + bg.transform.rotation)
    const toH = Math.min(Math.abs(ang), 180 - Math.abs(ang))
    const toV = Math.abs(90 - Math.abs(ang))
    setAlign(toH < 20 ? 'h' : toV < 20 ? 'v' : 'none')
  }, [calib?.step]) // eslint-disable-line react-hooks/exhaustive-deps
  const apply = () => {
    if (!calib?.a || !calib.b || !(mm > 0)) return
    patchBackground({ transform: calibrate(bg, calib.a, calib.b, mm, align), calib: { a: [calib.a.x, calib.a.y], b: [calib.b.x, calib.b.y], mm } })
    set(null)
  }
  if (!calib) {
    return (
      <div className="flex flex-col gap-2 px-1 pt-1">
        <p className="text-footnote text-secondary-label">
          在扫描件上点两个已知距离的点（比如第一条和最后一条格线的端点、或纸的两个角），输入它们的真实距离，就能准确定出比例；还可以顺便把这条线摆正。
        </p>
        <Button size="sm" variant="tinted" icon={<Ruler />} disabled={bg.locked} onClick={() => set({ step: 'a' })}>
          开始两点校准
        </Button>
        {bg.calib ? <p className="text-caption text-tertiary-label">上次校准：A–B = {bg.calib.mm} mm</p> : null}
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-2 px-1 pt-1">
      <ol className="flex flex-col gap-1 text-footnote">
        <li className={cn(calib.step === 'a' ? 'font-semibold text-label' : 'text-secondary-label')}>1. 在扫描件上点第一个点 A{calib.a ? ' ✓' : ''}</li>
        <li className={cn(calib.step === 'b' ? 'font-semibold text-label' : 'text-secondary-label')}>2. 点第二个点 B{calib.b ? ' ✓' : ''}（离 A 越远越准）</li>
        <li className={cn(calib.step === 'dist' ? 'font-semibold text-label' : 'text-secondary-label')}>3. 输入 A 到 B 的真实距离</li>
      </ol>
      {calib.step === 'dist' ? (
        <>
          <Row label="真实距离">
            <NumberField value={mm} onChange={setMm} unit="mm" step={0.5} min={0.5} max={5000} className="w-full" aria-label="A 到 B 的真实距离" />
          </Row>
          <p className="text-caption text-tertiary-label">现在画布上量得 {measured.toFixed(1)} mm</p>
          <Row label="同时摆正">
            <Segmented size="sm" block value={align} onValueChange={setAlign} options={[{ value: 'none', label: '不转' }, { value: 'h', label: '水平' }, { value: 'v', label: '竖直' }]} aria-label="把 A–B 摆成" />
          </Row>
          <div className="flex gap-1.5">
            <Button size="sm" variant="filled" icon={<Check />} disabled={!(mm > 0)} onClick={apply}>
              应用
            </Button>
            <Button size="sm" variant="gray" onClick={() => set({ step: 'a' })}>
              重新选点
            </Button>
            <Button size="sm" variant="plain" icon={<X />} onClick={() => set(null)}>
              取消
            </Button>
          </div>
        </>
      ) : (
        <Button size="sm" variant="plain" icon={<X />} onClick={() => set(null)} className="self-start">
          取消校准
        </Button>
      )}
    </div>
  )
}

function RotateTab({ bg }: { bg: PageBackground }) {
  const rot = (d: number, abs = false) => patchBackground((b) => ({ transform: { ...b.transform, rotation: normDeg(abs ? d : b.transform.rotation + d) } }), { coalesce: 'rotate' })
  const dis = bg.locked
  return (
    <div className="flex flex-col gap-1.5 pt-1">
      <Row label="角度">
        <NumberField value={Math.round(normDeg(bg.transform.rotation) * 10) / 10} onChange={(v) => rot(v, true)} unit="°" step={0.1} precision={1} min={-180} max={180} disabled={dis} className="w-full" aria-label="背景旋转角度" />
      </Row>
      <div className="grid grid-cols-4 gap-1.5 px-1">
        <Button size="sm" variant="gray" icon={<RotateCcw />} disabled={dis} onClick={() => rot(-90)} aria-label="逆时针 90°">90°</Button>
        <Button size="sm" variant="gray" disabled={dis} onClick={() => rot(-0.1)} aria-label="逆时针 0.1°">−0.1°</Button>
        <Button size="sm" variant="gray" disabled={dis} onClick={() => rot(0.1)} aria-label="顺时针 0.1°">+0.1°</Button>
        <Button size="sm" variant="gray" icon={<RotateCw />} disabled={dis} onClick={() => rot(90)} aria-label="顺时针 90°">90°</Button>
      </div>
      <Row label="微调">
        <Slider value={[Math.max(-10, Math.min(10, normDeg(bg.transform.rotation - Math.round(bg.transform.rotation / 90) * 90)))]} min={-10} max={10} step={0.1} disabled={dis}
          onValueChange={([x]) => rot(Math.round(bg.transform.rotation / 90) * 90 + x, true)} className="min-w-0 flex-1" aria-label="在 ±10° 内微调" />
      </Row>
      <div className="flex gap-1.5 px-1">
        <Button size="sm" variant="plain" disabled={dis} onClick={() => rot(Math.round(bg.transform.rotation / 90) * 90, true)}>
          摆正到最近的 90°
        </Button>
      </div>
      <p className="px-1 text-caption text-tertiary-label">扫描歪了一点？用「两点」把一条格线摆成水平最快。</p>
    </div>
  )
}

function MoveTab({ bg }: { bg: PageBackground }) {
  const [step, setStep] = React.useState(0.5)
  const nudge = (dx: number, dy: number) => patchBackground((b) => ({ transform: { ...b.transform, x: b.transform.x + dx * step, y: b.transform.y + dy * step } }), { coalesce: 'move' })
  const paper = currentPaper()
  const { w: pw, h: ph } = paperDims(paper)
  const dis = bg.locked
  return (
    <div className="flex flex-col gap-1.5 pt-1">
      <Row label="中心 X">
        <NumberField value={Math.round(bg.transform.x * 10) / 10} onChange={(v) => patchBackground({ transform: { ...bg.transform, x: v } }, { coalesce: 'move' })} unit="mm" step={0.5} disabled={dis} className="w-full" aria-label="背景中心 X" />
      </Row>
      <Row label="中心 Y">
        <NumberField value={Math.round(bg.transform.y * 10) / 10} onChange={(v) => patchBackground({ transform: { ...bg.transform, y: v } }, { coalesce: 'move' })} unit="mm" step={0.5} disabled={dis} className="w-full" aria-label="背景中心 Y" />
      </Row>
      <div className="flex items-center gap-2 px-1">
        <div className="grid grid-cols-3 gap-1">
          <span />
          <IconButton label="上移" size="sm" disabled={dis} onClick={() => nudge(0, -1)}><ArrowUp /></IconButton>
          <span />
          <IconButton label="左移" size="sm" disabled={dis} onClick={() => nudge(-1, 0)}><ArrowLeft /></IconButton>
          <IconButton label="下移" size="sm" disabled={dis} onClick={() => nudge(0, 1)}><ArrowDown /></IconButton>
          <IconButton label="右移" size="sm" disabled={dis} onClick={() => nudge(1, 0)}><ArrowRight /></IconButton>
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <Segmented size="sm" block value={String(step)} onValueChange={(v) => setStep(Number(v))} options={[{ value: '0.1', label: '0.1' }, { value: '0.5', label: '0.5' }, { value: '2', label: '2 mm' }]} aria-label="微移步长" />
          <Button size="sm" variant="plain" disabled={dis} onClick={() => patchBackground({ transform: { ...bg.transform, x: pw / 2, y: ph / 2 } })}>
            居中到纸张
          </Button>
        </div>
      </div>
      <p className="px-1 text-caption text-tertiary-label">键盘：方向键 0.1 mm，Shift+方向键 1 mm。</p>
    </div>
  )
}

function ViewTab({ bg }: { bg: PageBackground }) {
  return (
    <div className="flex flex-col gap-1.5 pt-1">
      <Row label="显示">
        <Switch checked={bg.visible} onCheckedChange={(v) => patchBackground({ visible: v })} aria-label="显示参考背景" />
      </Row>
      <Row label="不透明度">
        <Slider value={[Math.round(bg.opacity * 100)]} min={5} max={100} step={5} onValueChange={([x]) => patchBackground({ opacity: x / 100 }, { coalesce: 'opacity' })} className="min-w-0 flex-1" aria-label="背景不透明度" />
        <span className="w-9 shrink-0 text-right text-footnote tabular-nums text-secondary-label">{Math.round(bg.opacity * 100)}%</span>
      </Row>
      <Row label="锁定">
        <Switch checked={bg.locked} onCheckedChange={(v) => patchBackground({ locked: v })} aria-label="锁定参考背景" />
      </Row>
      <div className="flex flex-wrap gap-1.5 px-1 pt-1">
        {bg.page_count > 1 ? (
          <Button size="sm" variant="gray" onClick={() => usePagesDialog.getState().set(true)}>
            PDF 第 {bg.page + 1}/{bg.page_count} 页…
          </Button>
        ) : null}
        <Button size="sm" variant="gray" icon={<FileImage />} onClick={() => void importBackgroundInteractive()}>
          更换
        </Button>
        <Button size="sm" variant="plain" icon={<Trash2 />} className="text-red" onClick={() => void askRemove()}>
          移除
        </Button>
      </div>
      <Note tone="gray">背景只用来参考对齐，打印、G 代码和 SVG 里都没有它。</Note>
    </div>
  )
}

// ------------------------------------------------------------------ PDF page picker

export function BackgroundPagesDialog() {
  const open = usePagesDialog((s) => s.open)
  const setOpen = usePagesDialog((s) => s.set)
  const bg = useBg()
  const [busy, setBusy] = React.useState<number | null>(null)
  const n = Math.min(bg?.page_count ?? 0, 80)
  return (
    <Dialog open={open && !!bg?.source_id} onOpenChange={setOpen}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>选择 PDF 页面作背景</DialogTitle>
          <p className="text-callout text-secondary-label">共 {bg?.page_count} 页。换页后会尽量保持已对齐的位置和比例。</p>
        </DialogHeader>
        <DialogBody>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(112px,1fr))] gap-3">
            {bg?.source_id
              ? Array.from({ length: n }, (_, i) => (
                  <button
                    key={i}
                    type="button"
                    className={cn('press focus-ring flex flex-col items-center gap-1 rounded-lg p-2 hover:bg-fill/60', i === bg.page && 'bg-accent/15 ring-2 ring-accent')}
                    onClick={async () => {
                      if (i !== bg.page) {
                        setBusy(i)
                        await setBackgroundPage(i)
                        setBusy(null)
                      }
                      setOpen(false)
                    }}
                    aria-label={`第 ${i + 1} 页`}
                    aria-pressed={i === bg.page}
                  >
                    <span className="flex h-36 w-full items-center justify-center">
                      <img src={pdfThumbUrl(bg.source_id!, i, 240)} alt="" loading="lazy" className={cn('max-h-full max-w-full bg-white shadow-paper', busy === i && 'opacity-50')} />
                    </span>
                    <span className="text-footnote tabular-nums text-secondary-label">第 {i + 1} 页</span>
                  </button>
                ))
              : null}
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}
