/**
 * Reference background (Page.background) geometry + edit actions. The background is a raster of px_w×px_h pixels
 * placed with transform {x, y = page mm of its centre, scale = mm per pixel, rotation = ° clockwise around the
 * centre}. It is never rendered/printed (the backend ignores it for paths and G-code).
 */
import { backgroundPage, importBackground, type BackgroundImportResult, type PageBackground } from '@/api/studio-background'
import { errorMessage } from '@/api/client'
import { toast } from '@/lib/toast'
import { currentPaper } from './actions'
import type { Box, Pt } from './geometry'
import { paperDims } from './model'
import { useStudio } from './store'

export type { PageBackground }

const rad = (d: number) => (d * Math.PI) / 180
const r4 = (v: number) => Math.round(v * 10000) / 10000

/** Image pixel → page mm. */
export function imgToPage(bg: PageBackground, q: Pt): Pt {
  const t = bg.transform
  const c = Math.cos(rad(t.rotation))
  const s = Math.sin(rad(t.rotation))
  const u = (q.x - bg.px_w / 2) * t.scale
  const v = (q.y - bg.px_h / 2) * t.scale
  return { x: t.x + u * c - v * s, y: t.y + u * s + v * c }
}

/** Page mm → image pixel. */
export function pageToImg(bg: PageBackground, p: Pt): Pt {
  const t = bg.transform
  const c = Math.cos(rad(t.rotation))
  const s = Math.sin(rad(t.rotation))
  const dx = p.x - t.x
  const dy = p.y - t.y
  return { x: (dx * c + dy * s) / t.scale + bg.px_w / 2, y: (-dx * s + dy * c) / t.scale + bg.px_h / 2 }
}

/** SVG transform placing an <image width=px_w height=px_h> on the page. */
export function bgSvgTransform(bg: PageBackground) {
  const t = bg.transform
  return `translate(${t.x} ${t.y}) rotate(${t.rotation}) scale(${t.scale}) translate(${-bg.px_w / 2} ${-bg.px_h / 2})`
}

export function bgCorners(bg: PageBackground): Pt[] {
  return [
    imgToPage(bg, { x: 0, y: 0 }),
    imgToPage(bg, { x: bg.px_w, y: 0 }),
    imgToPage(bg, { x: bg.px_w, y: bg.px_h }),
    imgToPage(bg, { x: 0, y: bg.px_h }),
  ]
}

export function bgSize(bg: PageBackground) {
  return { w: bg.px_w * bg.transform.scale, h: bg.px_h * bg.transform.scale }
}

export function bgAABB(bg: PageBackground): Box {
  const cs = bgCorners(bg)
  const xs = cs.map((p) => p.x)
  const ys = cs.map((p) => p.y)
  return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) }
}

/** Snap points of the background: corners, edge midpoints, centre, calibration points. */
export function bgSnapPoints(bg: PageBackground): { p: Pt; label: string }[] {
  const cs = bgCorners(bg)
  const out = cs.map((p) => ({ p, label: '背景角' }))
  for (let i = 0; i < 4; i++) out.push({ p: { x: (cs[i].x + cs[(i + 1) % 4].x) / 2, y: (cs[i].y + cs[(i + 1) % 4].y) / 2 }, label: '背景边' })
  if (bg.calib) {
    out.push({ p: imgToPage(bg, { x: bg.calib.a[0], y: bg.calib.a[1] }), label: '校准点 A' })
    out.push({ p: imgToPage(bg, { x: bg.calib.b[0], y: bg.calib.b[1] }), label: '校准点 B' })
  }
  return out
}

/** Normalise an angle to (-180, 180]. */
export function normDeg(d: number) {
  let a = ((d % 360) + 360) % 360
  if (a > 180) a -= 360
  return r4(a)
}

/** New transform with the centre moved so that image point q lands on page point p. */
function pinned(bg: PageBackground, scale: number, rotation: number, q: Pt, p: Pt): PageBackground['transform'] {
  const c = Math.cos(rad(rotation))
  const s = Math.sin(rad(rotation))
  const u = (q.x - bg.px_w / 2) * scale
  const v = (q.y - bg.px_h / 2) * scale
  return { x: r4(p.x - (u * c - v * s)), y: r4(p.y - (u * s + v * c)), scale: r4(scale * 1e4) / 1e4, rotation: normDeg(rotation) }
}

/** Scale/rotate around a page pivot (the pivot stays fixed). */
export function aroundPivot(bg: PageBackground, scale: number, rotation: number, pivot: Pt): PageBackground['transform'] {
  return pinned(bg, scale, rotation, pageToImg(bg, pivot), pivot)
}

/** Physical width (mm) → transform keeping the centre. */
export function withWidth(bg: PageBackground, wmm: number): PageBackground['transform'] {
  return { ...bg.transform, scale: Math.max(1e-6, wmm / bg.px_w) }
}

/** "匹配纸张": rotation snapped to the nearest 90°, scaled so the (rotated) width equals the paper width, centred. */
export function fitToPaper(bg: PageBackground, pw: number, ph: number, mode: 'width' | 'contain' = 'width'): PageBackground['transform'] {
  const rot = Math.round(bg.transform.rotation / 90) * 90
  const swap = Math.abs(rot) % 180 === 90
  const iw = swap ? bg.px_h : bg.px_w
  const ih = swap ? bg.px_w : bg.px_h
  const scale = mode === 'width' ? pw / iw : Math.min(pw / iw, ph / ih)
  return { x: pw / 2, y: ph / 2, scale, rotation: normDeg(rot) }
}

/** Initial placement after an import: natural physical size if known, else fit the paper; centred. */
export function initialTransform(r: Pick<BackgroundImportResult, 'px_w' | 'px_h' | 'natural_mm'>, pw: number, ph: number): PageBackground['transform'] {
  const nat = r.natural_mm && r.natural_mm[0] > 0 ? r.natural_mm[0] / r.px_w : null
  return { x: pw / 2, y: ph / 2, scale: nat ?? Math.min(pw / r.px_w, ph / r.px_h), rotation: 0 }
}

/**
 * Two-point calibration: image points a, b are `mm` apart in reality → scale. Optionally rotate so the segment
 * a→b is horizontal / vertical on the page. Point a stays where it is on the page.
 */
export function calibrate(bg: PageBackground, a: Pt, b: Pt, mm: number, align: 'none' | 'h' | 'v'): PageBackground['transform'] {
  const dpx = Math.hypot(b.x - a.x, b.y - a.y)
  if (dpx < 1e-6 || !(mm > 0)) return bg.transform
  const scale = mm / dpx
  const phi = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI // segment angle in image space
  let rotation = bg.transform.rotation
  const onPage = phi + rotation
  if (align === 'h') rotation = Math.round(onPage / 180) * 180 - phi
  else if (align === 'v') rotation = Math.round((onPage - 90) / 180) * 180 + 90 - phi
  return pinned(bg, scale, rotation, a, imgToPage(bg, a))
}

// ------------------------------------------------------------------ edits

export function pageBackground(pageIndex?: number): PageBackground | null {
  const s = useStudio.getState()
  return s.doc?.pages[pageIndex ?? s.view.page]?.background ?? null
}

/** Patch the current page's background. `coalesce` groups rapid edits (sliders/drags) into one undo step. */
export function patchBackground(patch: Partial<PageBackground> | ((bg: PageBackground) => Partial<PageBackground>), opts: { coalesce?: string; record?: boolean } = {}) {
  const s = useStudio.getState()
  const pi = s.view.page
  s.edit((doc) => {
    const page = doc.pages[pi]
    if (!page?.background) return
    const p = typeof patch === 'function' ? patch(page.background) : patch
    page.background = { ...page.background, ...p }
  }, { coalesce: opts.coalesce ? `bg.${opts.coalesce}` : undefined, record: opts.record })
}

/** Live (no history) background transform during a drag; call `checkpoint()` once before. */
export function liveBackground(t: PageBackground['transform']) {
  const s = useStudio.getState()
  const pi = s.view.page
  s.edit(
    (doc) => ({ ...doc, pages: doc.pages.map((p, i) => (i !== pi || !p.background ? p : { ...p, background: { ...p.background, transform: t } })) }),
    { record: false, clone: false },
  )
}

export function removeBackground() {
  const s = useStudio.getState()
  const pi = s.view.page
  s.edit((doc) => {
    const page = doc.pages[pi]
    if (page) page.background = null
  })
  if (s.bgAlign) s.setBgAlign(false)
}

/** Show/hide every page's background at once (toolbar / shortcut B). */
export function toggleBackgrounds(force?: boolean) {
  const s = useStudio.getState()
  if (!s.doc) return
  const any = s.doc.pages.some((p) => p.background)
  if (!any) {
    toast.info('这一页还没有参考背景', { description: '在右侧「纸张」里导入扫描件或 PDF 模板。' })
    return
  }
  const show = force ?? !s.doc.pages.some((p) => p.background?.visible)
  s.edit((doc) => {
    for (const p of doc.pages) if (p.background) p.background = { ...p.background, visible: show }
  })
  toast.info(show ? '参考背景：显示' : '参考背景：隐藏', { key: 'bg-visible', duration: 1500, ephemeral: true })
}

function fromImport(r: BackgroundImportResult, name: string, prev: PageBackground | null, keepTransform: boolean): PageBackground {
  const paper = currentPaper()
  const { w, h } = paperDims(paper)
  const t = keepTransform && prev ? { ...prev.transform, scale: prev.transform.scale * (prev.px_w / r.px_w) } : initialTransform(r, w, h)
  return {
    file_id: r.file.id,
    source_id: r.source?.id ?? prev?.source_id ?? null,
    page: r.page,
    page_count: r.page_count,
    name,
    px_w: r.px_w,
    px_h: r.px_h,
    natural_mm: r.natural_mm ?? null,
    transform: t,
    opacity: prev?.opacity ?? 0.5,
    visible: true,
    locked: false,
    calib: keepTransform ? (prev?.calib ?? null) : null,
  }
}

/** Upload an image / PDF and set it as the current page's background, then enter the alignment mode. */
export async function setBackgroundFromFile(file: File, opts: { page?: number; align?: boolean } = {}) {
  const s = useStudio.getState()
  if (!s.doc) return
  const pi = s.view.page
  const tid = toast.info(`正在导入背景 ${file.name}…`, { duration: 120_000, ephemeral: true })
  try {
    const r = await importBackground(file, { page: opts.page ?? 0 })
    const bg = fromImport(r, file.name, null, false)
    useStudio.getState().edit((doc) => {
      const page = doc.pages[pi]
      if (page) page.background = bg
    })
    toast.dismiss(tid)
    toast.success(r.source ? `已导入 PDF 第 ${r.page + 1} 页（共 ${r.page_count} 页）作为参考背景` : '已导入参考背景', {
      description: r.natural_mm ? `按文件里的尺寸放置：${r.natural_mm[0].toFixed(0)}×${r.natural_mm[1].toFixed(0)} mm。背景不会被写出来。` : '已按纸张大小放置，请用「对齐背景」校准尺寸。背景不会被写出来。',
    })
    if (opts.align !== false) useStudio.getState().setBgAlign(true)
    return bg
  } catch (e) {
    toast.dismiss(tid)
    toast.error('无法导入背景', { description: errorMessage(e) })
    return null
  }
}

/** Switch the PDF page of the current background (keeps the alignment when the page size matches). */
export async function setBackgroundPage(page: number) {
  const bg = pageBackground()
  if (!bg?.source_id) return
  const pi = useStudio.getState().view.page
  try {
    const r = await backgroundPage(bg.source_id, page)
    const keep = Math.abs(r.px_w / r.px_h - bg.px_w / bg.px_h) < 0.01
    const next = fromImport(r, bg.name ?? '', bg, keep)
    useStudio.getState().edit((doc) => {
      const p = doc.pages[pi]
      if (p) p.background = next
    })
  } catch (e) {
    toast.error('无法切换页面', { description: errorMessage(e) })
  }
}
