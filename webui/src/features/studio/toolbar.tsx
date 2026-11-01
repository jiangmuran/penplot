/** Studio toolbar items (regular), canvas status bar, compact bottom bars. */
import {
  ChevronDown, Circle, Copy, Crosshair, Download, Eye, FileCode2, FilePlus2, FileUp, FolderOpen, Grid3x3, Hand, Image as ImageIcon,
  LayoutTemplate, Layers, Lock, Maximize, Minus, MousePointer2, MoreHorizontal, PenTool, Pencil, Play, Plus, Printer, Redo2,
  RectangleHorizontal, Settings2, Shapes, Slash, Trash2, Triangle, Type, Undo2, Users, FileImage, ImageOff, Ruler,
} from 'lucide-react'
import * as React from 'react'
import { useShallow } from 'zustand/react/shallow'
import {
  Button, DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuTrigger, IconButton, Input, Popover, PopoverContent, PopoverTrigger, Segmented, Spinner, Tooltip,
} from '@/components/ui'
import { cn } from '@/lib/cn'
import { useBreakpoint } from '@/lib/media'
import { formatDurationSpoken } from '@/lib/format'
import { deleteSelection, duplicateSelection, insertShape, insertText, setMode, toggleLock, zOrder } from './actions'
import { MM_100 } from './canvas/canvas'
import { useCollab } from './collab'
import { isLetterMode } from './model'
import { outputIndex, usePageUpdating, useRender } from './render-engine'
import { useStudio, type Tool } from './store'
import { toggleBackgrounds } from './background'
import { importBackgroundInteractive } from './sheets/background-panel'

/** Background state for toolbar items: any page has one / current page's is visible. */
function useBgState() {
  return useStudio(useShallow((s) => ({
    any: !!s.doc?.pages.some((p) => p.background),
    here: !!s.doc?.pages[s.view.page]?.background,
    visible: !!s.doc?.pages.some((p) => p.background?.visible),
    align: s.bgAlign,
  })))
}

export function BackgroundToggle() {
  const bg = useBgState()
  const bp = useBreakpoint()
  // regular only: the medium toolbar is already full (View menu / B / inspector cover it there)
  if (!bg.any || bp !== 'regular') return null
  return (
    <IconButton label={bg.visible ? '隐藏参考背景' : '显示参考背景'} shortcut="b" active={bg.visible} onClick={() => toggleBackgrounds()}>
      {bg.visible ? <FileImage /> : <ImageOff />}
    </IconButton>
  )
}

export interface StudioCommands {
  openProjects: () => void
  openPrint: () => void
  openExport: () => void
  openPosition: () => void
  openImport: (accept?: string) => void
  openTemplate: () => void
  rename: () => void
  duplicate: () => void
  newProject: () => void
  preview: () => void
  openInspector?: () => void
  openLayers?: () => void
  openTextEdit?: () => void
}

export function SaveIndicator() {
  const { state, err } = useStudio(useShallow((s) => ({ state: s.saveState, err: s.saveError })))
  const map = {
    saved: { t: '已保存', c: 'text-secondary-label' },
    dirty: { t: '未保存', c: 'text-secondary-label' },
    saving: { t: '正在保存…', c: 'text-secondary-label' },
    error: { t: '保存失败', c: 'text-red' },
    offline: { t: '离线 · 稍后保存', c: 'text-on-tint-orange' },
    conflict: { t: '版本冲突', c: 'text-red' },
  }[state]
  return (
    <span className={cn('whitespace-nowrap text-footnote', map.c)} title={err ?? undefined} aria-live="polite">
      {map.t}
    </span>
  )
}

export function ProjectMenu({ cmd }: { cmd: StudioCommands }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton label="项目菜单" size="sm">
          <ChevronDown />
        </IconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-52">
        <DropdownMenuItem onSelect={cmd.openProjects} icon={<FolderOpen />}>
          打开项目…
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={cmd.newProject} icon={<FilePlus2 />}>
          新建
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={cmd.rename} icon={<Pencil />}>
          重命名…
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={cmd.duplicate} icon={<Copy />}>
          复制项目
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={cmd.openTemplate} icon={<LayoutTemplate />}>
          存为模板…
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => cmd.openImport('.json,.penplot.json,.zip')} icon={<FileUp />}>
          导入项目 JSON…
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={cmd.openExport} icon={<Download />}>
          导出…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function UndoRedo() {
  const { canUndo, canRedo } = useStudio(useShallow((s) => ({ canUndo: s.past.length > 0, canRedo: s.future.length > 0 })))
  return (
    <div className="flex items-center">
      <IconButton label="撤销" shortcut="mod+z" disabled={!canUndo} onClick={() => useStudio.getState().undo()}>
        <Undo2 />
      </IconButton>
      <IconButton label="重做" shortcut="mod+shift+z" disabled={!canRedo} onClick={() => useStudio.getState().redo()}>
        <Redo2 />
      </IconButton>
    </div>
  )
}

export function ModeSwitch() {
  const letter = useStudio((s) => (s.doc ? isLetterMode(s.doc) : false))
  return (
    <Segmented
      value={letter ? 'letter' : 'free'}
      onValueChange={(v) => setMode(v)}
      options={[{ value: 'free', label: '自由' }, { value: 'letter', label: '信笺' }]}
      size="sm"
      aria-label="文档模式"
    />
  )
}

const TOOLS: { t: Tool; icon: typeof Type; label: string; key: string }[] = [
  { t: 'select', icon: MousePointer2, label: '选择', key: 'v' },
  { t: 'hand', icon: Hand, label: '抓手', key: 'h' },
  { t: 'text', icon: Type, label: '文本框（拖出大小）', key: 't' },
]

export function ToolButtons({ cmd }: { cmd: StudioCommands }) {
  const tool = useStudio((s) => s.tool)
  const shapeTool = tool === 'rect' || tool === 'ellipse' || tool === 'line'
  return (
    <div className="flex items-center gap-0.5">
      {TOOLS.map((x) => (
        <IconButton key={x.t} label={x.label} shortcut={x.key} active={tool === x.t} onClick={() => useStudio.getState().setTool(x.t)}>
          <x.icon />
        </IconButton>
      ))}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <IconButton label="形状" active={shapeTool}>
            <Shapes />
          </IconButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuLabel>在画布上拖出</DropdownMenuLabel>
          <DropdownMenuItem shortcut="r" onSelect={() => useStudio.getState().setTool('rect')} icon={<RectangleHorizontal />}>
            矩形
          </DropdownMenuItem>
          <DropdownMenuItem shortcut="o" onSelect={() => useStudio.getState().setTool('ellipse')} icon={<Circle />}>
            椭圆
          </DropdownMenuItem>
          <DropdownMenuItem shortcut="l" onSelect={() => useStudio.getState().setTool('line')} icon={<Slash />}>
            直线
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuLabel>直接插入</DropdownMenuLabel>
          <DropdownMenuItem onSelect={() => insertShape('polygon')} icon={<Triangle />}>三角形</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => insertShape('grid')} icon={<Grid3x3 />}>
            田字格
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <InsertMenu cmd={cmd} />
    </div>
  )
}

export function InsertMenu({ cmd, trigger }: { cmd: StudioCommands; trigger?: React.ReactNode }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {trigger ?? (
          <IconButton label="插入文件">
            <ImageIcon />
          </IconButton>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem onSelect={() => insertText()} icon={<Type />}>
          文本框
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => insertShape('rect')} icon={<RectangleHorizontal />}>
          矩形
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => insertShape('grid')} icon={<Grid3x3 />}>
          田字格
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => cmd.openImport('.png,.jpg,.jpeg,.webp')} icon={<ImageIcon />}>
          图片…
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => cmd.openImport('.svg,.dxf')} icon={<PenTool />}>
          SVG / DXF 矢量…
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => cmd.openImport('.gcode,.nc,.gco')} icon={<FileCode2 />}>
          G 代码…
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => cmd.openImport('.txt')} icon={<Type />}>
          文本文件…
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void importBackgroundInteractive()} icon={<FileImage />}>
          参考背景（扫描件 / PDF）…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function Collaborators() {
  const peers = useCollab((s) => s.peers)
  const me = useCollab((s) => s.me)
  const list = Object.values(peers)
  const [name, setName] = React.useState(me.name)
  return (
    <Popover onOpenChange={(o) => o && setName(me.name)}>
      <PopoverTrigger asChild>
        <button type="button" className="press focus-ring flex items-center -space-x-1.5 rounded-full p-0.5" aria-label={list.length ? `${list.length} 人也在编辑` : '协作'}>
          {list.length ? (
            list.slice(0, 3).map((p) => <Avatar key={p.client} name={p.name} color={p.color} />)
          ) : (
            <span className="flex size-7 items-center justify-center text-secondary-label">
              <Users className="size-[18px]" />
            </span>
          )}
          {list.length > 3 ? <span className="flex size-6 items-center justify-center rounded-full bg-fill text-caption ring-2 ring-bg">+{list.length - 3}</span> : null}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72">
        <h3 className="mb-2 text-headline">正在查看此项目</h3>
        <ul className="mb-3 flex flex-col gap-1.5">
          <li className="flex items-center gap-2">
            <Avatar name={me.name} color={me.color} />
            <span className="text-body">{me.name}（你）</span>
          </li>
          {list.map((p) => (
            <li key={p.client} className="flex items-center gap-2">
              <Avatar name={p.name} color={p.color} />
              <span className="min-w-0 flex-1 truncate text-body">{p.name}</span>
              <span className="text-footnote text-secondary-label">第 {p.page + 1} 页{p.selection.length ? ' · 编辑中' : ''}</span>
            </li>
          ))}
        </ul>
        {!list.length ? <p className="mb-3 text-footnote text-secondary-label">在另一台设备或窗口打开同一项目，修改会实时同步。</p> : null}
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            useCollab.getState().setName(name)
          }}
        >
          <Input value={name} onChange={(e) => setName(e.currentTarget.value)} aria-label="我的显示名称" className="min-w-0 flex-1" />
          <Button type="submit" size="sm">
            改名
          </Button>
        </form>
      </PopoverContent>
    </Popover>
  )
}

export function Avatar({ name, color, size = 26 }: { name: string; color: string; size?: number }) {
  return (
    <Tooltip content={name}>
      <span className="flex shrink-0 items-center justify-center rounded-full font-semibold text-white ring-2 ring-bg" style={{ width: size, height: size, background: color, fontSize: 12 }}>
        {[...name.trim()][0]?.toUpperCase() ?? '?'}
      </span>
    </Tooltip>
  )
}

export function PrimaryActions({ cmd, compact }: { cmd: StudioCommands; compact: boolean }) {
  const animate = useStudio((s) => s.animate)
  if (compact) {
    return (
      <>
        <IconButton label="打印" shortcut="mod+p" onClick={cmd.openPrint} variant="tinted" size="sm">
          <Printer />
        </IconButton>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <IconButton label="更多" size="sm">
              <MoreHorizontal />
            </IconButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-52">
            <DropdownMenuItem onSelect={cmd.preview} icon={<Play />}>
              笔顺预览
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={cmd.openPosition} icon={<Crosshair />}>
              位置预览 · 走边框
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={cmd.openExport} icon={<Download />}>
              导出…
            </DropdownMenuItem>
            <CompactBgItems />
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => setMode(isLetterMode(useStudio.getState().doc!) ? 'free' : 'letter')} icon={<Pencil />}>
              切换 自由 / 信笺
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={cmd.openProjects} icon={<FolderOpen />}>
              项目与模板…
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={cmd.rename} icon={<Pencil />}>
              重命名…
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={cmd.openTemplate} icon={<LayoutTemplate />}>
              存为模板…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </>
    )
  }
  return (
    <>
      <BackgroundToggle />
      <IconButton label="笔顺预览" shortcut="mod+enter" active={animate} onClick={cmd.preview}>
        <Play />
      </IconButton>
      <IconButton label="位置预览 · 走边框" onClick={cmd.openPosition}>
        <Crosshair />
      </IconButton>
      <IconButton label="导出" shortcut="mod+shift+e" onClick={cmd.openExport}>
        <Download />
      </IconButton>
      <Button variant="filled" size="md" icon={<Printer />} onClick={cmd.openPrint} title="打印（⌘P）" className="ml-1">
        打印
      </Button>
    </>
  )
}

/** Floating bar at the bottom of the canvas: zoom, preview mode, overlays, stats. */
export function CanvasBar({ compact }: { compact: boolean }) {
  const { zoom, overlays, animate, view, version, tool } = useStudio(useShallow((s) => ({ zoom: s.zoom, overlays: s.overlays, animate: s.animate, view: s.view, version: s.version, tool: s.tool })))
  const page = useRender((s) => s.page)
  const idx = outputIndex(page.result, view.page, view.sub)
  const rp = idx != null ? page.result?.pages[idx] : null
  const pct = Math.round((zoom.zoom / MM_100) * 100)
  const setZ = (z: number) => {
    const s = useStudio.getState()
    const host = document.querySelector('[data-studio-canvas]') as HTMLElement | null
    const cx = (host?.clientWidth ?? 800) / 2
    const cy = (host?.clientHeight ?? 600) / 2
    const f = z / s.zoom.zoom
    s.setZoom({ zoom: z, panX: cx - (cx - s.zoom.panX) * f, panY: cy - (cy - s.zoom.panY) * f })
  }
  const stale = usePageUpdating(version)
  return (
    <div className={cn('mat-thin pointer-events-auto flex items-center gap-1 rounded-xl px-1.5 py-1 shadow-md ring-1 ring-separator/50', compact && 'gap-0.5')}>
      {!compact ? (
        <Segmented
          value={tool === 'hand' ? 'hand' : 'select'}
          onValueChange={(v) => useStudio.getState().setTool(v === 'hand' ? 'hand' : 'select')}
          options={[{ value: 'select', icon: MousePointer2, ariaLabel: '选择' }, { value: 'hand', icon: Hand, ariaLabel: '抓手' }]}
          size="sm"
        />
      ) : null}
      <IconButton label="缩小" shortcut="mod+-" size="sm" onClick={() => setZ(Math.max(0.15, zoom.zoom / 1.25))}>
        <Minus />
      </IconButton>
      <button type="button" className="press h-6 min-w-12 rounded-sm px-1 text-footnote tabular-nums text-label hover:bg-quaternary-fill" onClick={() => setZ(MM_100)} aria-label="缩放到 100%">
        {pct}%
      </button>
      <IconButton label="放大" shortcut="mod+=" size="sm" onClick={() => setZ(Math.min(80, zoom.zoom * 1.25))}>
        <Plus />
      </IconButton>
      <IconButton label="适合页面" shortcut="mod+0" size="sm" onClick={() => useStudio.getState().requestFit()}>
        <Maximize />
      </IconButton>
      <span className="mx-0.5 h-4 w-px bg-separator" />
      <Segmented
        value={animate ? 'order' : 'static'}
        onValueChange={(v) => useStudio.getState().setAnimate(v === 'order')}
        options={[{ value: 'static', label: '静态' }, { value: 'order', label: '笔顺' }]}
        size="sm"
        aria-label="预览方式"
      />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <IconButton label="视图" size="sm">
            <Eye />
          </IconButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-48">
          <DropdownMenuLabel>画布叠层</DropdownMenuLabel>
          {(
            [
              ['travel', '抬笔轨迹（空走）'],
              ['origin', '原点标记'],
              ['axes', '坐标轴箭头'],
              ['workArea', '机器行程'],
              ['grid', '1 mm 网格'],
              ['snap', '吸附与参考线'],
              ['rulers', '标尺'],
              ['source', '图片原图'],
            ] as const
          ).map(([k, label]) => (
            <DropdownMenuCheckboxItem key={k} checked={overlays[k]} onCheckedChange={(v) => useStudio.getState().setOverlay(k, !!v)} onSelect={(e) => e.preventDefault()}>
              {label}
            </DropdownMenuCheckboxItem>
          ))}
          <ViewBgItems />
        </DropdownMenuContent>
      </DropdownMenu>
      {!compact ? (
        <>
          <span className="mx-0.5 h-4 w-px bg-separator" />
          <span className="flex items-center gap-1.5 px-1.5 text-footnote tabular-nums text-secondary-label" aria-live="polite">
            {stale && rp ? (
              <span className="flex items-center gap-1 text-tertiary-label" title="正在按最新内容重新计算，先显示上一次的结果">
                <Spinner size={10} /> 更新中
              </span>
            ) : null}
            {rp ? (
              <>
                {rp.stats.strokes.toLocaleString('zh-CN')} 笔 · {(rp.stats.draw_mm / 1000).toFixed(1)} m · 抬笔 {rp.stats.pen_lifts} 次 · {formatDurationSpoken(rp.est_s)}
                {rp.out_of_work_area ? <span className="ml-1.5 text-red">超出行程</span> : null}
                {rp.warnings.missing_glyphs.length ? <span className="ml-1.5 text-on-tint-orange">缺 {rp.warnings.missing_glyphs.length} 字</span> : null}
              </>
            ) : page.status === 'error' ? (
              <span className="text-red">{page.error}</span>
            ) : (
              '正在计算…'
            )}
          </span>
        </>
      ) : null}
    </div>
  )
}

function ViewBgItems() {
  const bg = useBgState()
  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuLabel>参考背景（不打印）</DropdownMenuLabel>
      {bg.any ? (
        <DropdownMenuCheckboxItem checked={bg.visible} onCheckedChange={(v) => toggleBackgrounds(!!v)} onSelect={(e) => e.preventDefault()}>
          显示参考背景
        </DropdownMenuCheckboxItem>
      ) : null}
      {bg.here ? (
        <DropdownMenuItem onSelect={() => useStudio.getState().setBgAlign(!bg.align)} icon={<Ruler />}>
          {bg.align ? '完成对齐' : '对齐背景…'}
        </DropdownMenuItem>
      ) : (
        <DropdownMenuItem onSelect={() => void importBackgroundInteractive()} icon={<FileImage />}>
          导入扫描件 / PDF…
        </DropdownMenuItem>
      )}
    </>
  )
}

function CompactBgItems() {
  const bg = useBgState()
  return (
    <>
      {bg.here ? (
        <DropdownMenuItem onSelect={() => useStudio.getState().setBgAlign(!bg.align)} icon={<Ruler />}>
          {bg.align ? '完成对齐背景' : '对齐背景…'}
        </DropdownMenuItem>
      ) : (
        <DropdownMenuItem onSelect={() => void importBackgroundInteractive()} icon={<FileImage />}>
          导入参考背景…
        </DropdownMenuItem>
      )}
      {bg.any ? (
        <DropdownMenuItem onSelect={() => toggleBackgrounds()} icon={bg.visible ? <ImageOff /> : <Eye />}>
          {bg.visible ? '隐藏参考背景' : '显示参考背景'}
        </DropdownMenuItem>
      ) : null}
    </>
  )
}

/** Compact bottom toolbar (49) — becomes a context bar when something is selected. */
export function CompactBar({ cmd }: { cmd: StudioCommands }) {
  const sel = useStudio((s) => s.selection)
  const canUndo = useStudio((s) => s.past.length > 0)
  const btn = 'press flex min-w-0 flex-1 flex-col items-center justify-center gap-0.5 text-[11px] leading-none text-accent disabled:opacity-35 [&_svg]:size-[22px]'
  if (sel.length) {
    return (
      <div className="mat-thick hairline-t flex h-[49px] shrink-0 items-stretch px-1">
        <button type="button" className={btn} onClick={cmd.openTextEdit ?? cmd.openInspector}>
          <Pencil />
          编辑
        </button>
        <button type="button" className={btn} onClick={duplicateSelection}>
          <Copy />
          再制
        </button>
        <button type="button" className={btn} onClick={() => zOrder('top')}>
          <Layers />
          置前
        </button>
        <button type="button" className={btn} onClick={() => toggleLock()}>
          <Lock />
          锁定
        </button>
        <button type="button" className={btn} disabled={!canUndo} onClick={() => useStudio.getState().undo()}>
          <Undo2 />
          撤销
        </button>
        <button type="button" className={cn(btn, 'text-red')} onClick={deleteSelection}>
          <Trash2 />
          删除
        </button>
      </div>
    )
  }
  return (
    <div className="mat-thick hairline-t flex h-[49px] shrink-0 items-stretch px-1">
      <InsertMenu
        cmd={cmd}
        trigger={
          <button type="button" className={btn}>
            <Plus />
            插入
          </button>
        }
      />
      <button type="button" className={btn} onClick={() => insertText()}>
        <Type />
        文本
      </button>
      <button type="button" className={btn} onClick={cmd.openInspector}>
        <Settings2 />
        参数
      </button>
      <button type="button" className={btn} onClick={cmd.openLayers}>
        <Layers />
        图层
      </button>
      <button type="button" className={btn} disabled={!canUndo} onClick={() => useStudio.getState().undo()}>
        <Undo2 />
        撤销
      </button>
    </div>
  )
}

