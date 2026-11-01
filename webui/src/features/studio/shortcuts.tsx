/** Studio keyboard shortcuts (02-ux §5.2) + canvas keyboard access (§5.3: Tab cycles elements, announcements). */
import * as React from 'react'
import { isJobActive, useLive } from '@/api/store'
import { confirmStopJob } from '@/app/job-actions'
import { isEditableTarget } from '@/lib/platform'
import { useShortcut } from '@/lib/shortcuts'
import {
  copySelection, currentPaper, deleteSelection, duplicateSelection, elementAABB, nudge, paste, selectAll, toggleLock, zOrder,
} from './actions'
import { MM_100 } from './canvas/canvas'
import { elementName, sortedByZ, TYPE_LABEL } from './model'
import { saveNow } from './project-io'
import { patchBackground, toggleBackgrounds } from './background'
import { currentPage, useStudio } from './store'
import type { StudioCommands } from './toolbar'

const G = '创作台'

function layerOpen() {
  return !!document.querySelector('[role="dialog"][data-state="open"], [role="alertdialog"], [role="menu"][data-state="open"], [data-radix-popper-content-wrapper]')
}
function canvasFocused() {
  return !!document.activeElement?.closest('[data-studio-canvas]')
}

function zoomBy(f: number | 'reset') {
  const s = useStudio.getState()
  const host = document.querySelector('[data-studio-canvas]') as HTMLElement | null
  const cx = (host?.clientWidth ?? 800) / 2
  const cy = (host?.clientHeight ?? 600) / 2
  const z = f === 'reset' ? MM_100 : Math.min(80, Math.max(0.15, s.zoom.zoom * f))
  const k = z / s.zoom.zoom
  s.setZoom({ zoom: z, panX: cx - (cx - s.zoom.panX) * k, panY: cy - (cy - s.zoom.panY) * k })
}

export function announce(msg: string) {
  const el = document.getElementById('studio-live')
  if (el) el.textContent = msg
}

export function StudioShortcuts({ cmd }: { cmd: StudioCommands }) {
  const st = useStudio
  const hasSel = () => st.getState().selection.length > 0 && !layerOpen()
  const free = () => !layerOpen()
  useShortcut('mod+enter', cmd.preview, { id: 'studio.preview', description: '立即预览（笔顺）', group: G })
  useShortcut('mod+p', cmd.openPrint, { id: 'studio.print', description: '打印', group: G, allowInEditable: true })
  useShortcut('mod+shift+e', cmd.openExport, { id: 'studio.export', description: '导出', group: G })
  useShortcut('mod+o', () => cmd.openImport(), { id: 'studio.import', description: '导入文件', group: G })
  useShortcut('mod+s', () => void saveNow({ force: true }), { id: 'studio.save', description: '立即保存', group: G, allowInEditable: true })
  useShortcut('mod+z', () => st.getState().undo(), { id: 'studio.undo', description: '撤销', group: G, when: free })
  useShortcut('mod+shift+z', () => st.getState().redo(), { id: 'studio.redo', description: '重做', group: G, when: free })
  useShortcut('mod+y', () => st.getState().redo(), { id: 'studio.redo2', hidden: true, when: free })
  useShortcut('v', () => st.getState().setTool('select'), { id: 'studio.tool.v', description: '选择工具', group: G, when: free })
  useShortcut('h', () => st.getState().setTool('hand'), { id: 'studio.tool.h', description: '抓手工具', group: G, when: free })
  useShortcut('t', () => st.getState().setTool('text'), { id: 'studio.tool.t', description: '文本框', group: G, when: free })
  useShortcut('r', () => st.getState().setTool('rect'), { id: 'studio.tool.r', description: '矩形', group: G, when: free })
  useShortcut('o', () => st.getState().setTool('ellipse'), { id: 'studio.tool.o', description: '椭圆', group: G, when: free })
  useShortcut('l', () => st.getState().setTool('line'), { id: 'studio.tool.l', description: '直线', group: G, when: free })
  useShortcut('mod+c', () => copySelection(), { id: 'studio.copy', description: '拷贝', group: G, when: hasSel })
  useShortcut('mod+x', () => copySelection(true), { id: 'studio.cut', description: '剪切', group: G, when: hasSel })
  useShortcut('mod+v', () => paste(), { id: 'studio.paste', description: '粘贴', group: G, when: free })
  useShortcut('mod+d', duplicateSelection, { id: 'studio.dup', description: '再制', group: G, when: hasSel })
  useShortcut('mod+a', selectAll, { id: 'studio.all', description: '全选', group: G, when: free })
  useShortcut('delete', deleteSelection, { id: 'studio.del', description: '删除', group: G, when: hasSel })
  useShortcut('backspace', deleteSelection, { id: 'studio.del2', hidden: true, when: hasSel })
  useShortcut('mod+shift+l', () => toggleLock(), { id: 'studio.lock', description: '锁定 / 解锁', group: G, when: hasSel })
  useShortcut('mod+]', () => zOrder('up'), { id: 'studio.zup', description: '上移一层', group: G, when: hasSel })
  useShortcut('mod+[', () => zOrder('down'), { id: 'studio.zdown', description: '下移一层', group: G, when: hasSel })
  useShortcut('mod+shift+]', () => zOrder('top'), { id: 'studio.ztop', description: '置于顶层', group: G, when: hasSel })
  useShortcut('mod+shift+[', () => zOrder('bottom'), { id: 'studio.zbot', description: '置于底层', group: G, when: hasSel })
  useShortcut('mod+0', () => st.getState().requestFit(), { id: 'studio.fit', description: '适合页面', group: G })
  useShortcut('mod+=', () => zoomBy(1.25), { id: 'studio.zin', description: '放大', group: G })
  useShortcut('mod+-', () => zoomBy(0.8), { id: 'studio.zout', description: '缩小', group: G })
  useShortcut('mod+1', () => zoomBy('reset'), { id: 'studio.z100', description: '100%（画布聚焦时）', group: G, when: canvasFocused })
  useShortcut('b', () => toggleBackgrounds(), { id: 'studio.bg', description: '显示 / 隐藏参考背景', group: G, when: free })
  const bgNudge = (dx: number, dy: number) => {
    const s = st.getState()
    const bg = s.doc?.pages[s.view.page]?.background
    if (!s.bgAlign || !bg) return false
    if (bg.locked) return
    patchBackground((b) => ({ transform: { ...b.transform, x: b.transform.x + dx, y: b.transform.y + dy } }), { coalesce: 'nudge' })
  }
  for (const [k, dx, dy] of [['arrowleft', -1, 0], ['arrowright', 1, 0], ['arrowup', 0, -1], ['arrowdown', 0, 1]] as const) {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    useShortcut(k, () => {
      const s = st.getState()
      if (s.bgAlign) return bgNudge(dx * 0.1, dy * 0.1)
      if (!s.selection.length) {
        if (dy) return false
        const doc = s.doc
        if (!doc) return false
        const n = Math.max(0, Math.min(doc.pages.length - 1, s.view.page + dx))
        if (n !== s.view.page) s.setView({ page: n, sub: 0 })
        return
      }
      nudge(dx * 0.1, dy * 0.1)
    }, { id: `studio.nudge.${k}`, hidden: true, when: free })
    // eslint-disable-next-line react-hooks/rules-of-hooks
    useShortcut(`shift+${k}`, () => (st.getState().bgAlign ? bgNudge(dx, dy) : nudge(dx, dy)), { id: `studio.nudge1.${k}`, hidden: true, when: () => !layerOpen() && (st.getState().bgAlign || st.getState().selection.length > 0) })
  }
  useShortcut(
    'escape',
    () => {
      const s = st.getState()
      if (s.bgCalib) return s.setBgCalib(null)
      if (s.bgAlign) return s.setBgAlign(false)
      if (s.tool !== 'select') return s.setTool('select')
      if (s.selection.length) return s.select([])
      const job = useLive.getState().job
      if (job && isJobActive(job) && job.status === 'running') return void confirmStopJob(job)
      return false
    },
    { id: 'studio.esc', hidden: true, when: free },
  )
  useShortcut(
    'tab',
    () => {
      if (!canvasFocused()) return false
      const s = st.getState()
      const page = currentPage(s)
      if (!page) return false
      const list = sortedByZ(page.elements).filter((e) => !e.locked)
      if (!list.length) return false
      const i = list.findIndex((e) => e.id === s.selection[0])
      const next = list[(i + 1) % list.length]
      s.select([next.id])
      const b = elementAABB(next, currentPaper())
      announce(`已选中 ${TYPE_LABEL[next.type]}“${elementName(next)}”，X ${b.x.toFixed(1)} Y ${b.y.toFixed(1)} 毫米`)
    },
    { id: 'studio.tab', hidden: true },
  )
  useShortcut(
    'shift+tab',
    () => {
      if (!canvasFocused()) return false
      const s = st.getState()
      const page = currentPage(s)
      if (!page) return false
      const list = sortedByZ(page.elements).filter((e) => !e.locked)
      if (!list.length) return false
      const i = list.findIndex((e) => e.id === s.selection[0])
      const next = list[(i - 1 + list.length) % list.length]
      s.select([next.id])
      announce(`已选中 ${TYPE_LABEL[next.type]}“${elementName(next)}”`)
    },
    { id: 'studio.stab', hidden: true },
  )
  useShortcut(
    'enter',
    () => {
      if (!canvasFocused()) return false
      const s = st.getState()
      const el = currentPage(s)?.elements.find((e) => e.id === s.selection[0])
      if (!el) return false
      if (el.type === 'text' || el.type === 'flow_text') s.setEditText(el.id)
      cmd.openTextEdit?.()
    },
    { id: 'studio.enter', hidden: true },
  )

  // Space held = temporary hand (keyup needs a raw listener)
  React.useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || e.repeat || isEditableTarget(e.target) || layerOpen()) return
      e.preventDefault()
      st.getState().setSpaceHand(true)
    }
    const up = (e: KeyboardEvent) => {
      if (e.code === 'Space') st.getState().setSpaceHand(false)
    }
    const blur = () => st.getState().setSpaceHand(false)
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', blur)
    }
  }, [st])

  // announce selection changes (screen readers)
  React.useEffect(
    () =>
      st.subscribe((s, o) => {
        if (s.selection === o.selection || !s.selection.length) return
        const page = currentPage(s)
        const els = page?.elements.filter((e) => s.selection.includes(e.id)) ?? []
        if (els.length === 1) {
          const b = elementAABB(els[0], currentPaper())
          announce(`已选中 ${TYPE_LABEL[els[0].type]}“${elementName(els[0])}”，X ${b.x.toFixed(1)} Y ${b.y.toFixed(1)} 毫米`)
        } else if (els.length > 1) announce(`已选中 ${els.length} 个元素`)
      }),
    [st],
  )
  return <div id="studio-live" className="sr-only" aria-live="polite" />
}
