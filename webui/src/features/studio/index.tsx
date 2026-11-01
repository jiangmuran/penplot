/**
 * 创作台 /studio/:projectId? (02-ux §3.1). Opens the last / most recent project (or creates one), then lays out:
 * regular = [pages | layers] · canvas · inspector; compact = canvas + page strip + bottom bar, inspector/layers in sheets.
 */
import { useQuery } from '@tanstack/react-query'
import { TriangleAlert } from 'lucide-react'
import * as React from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { api, isApiError } from '@/api/client'
import { useCanEdit } from '@/api/collab'
import { queryClient, qk } from '@/api/query'
import type { Project, ProjectSummary } from '@/api/studio'
import { Page } from '@/app/page'
import { useUi } from '@/app/ui-store'
import {
  AlertDialogContent, AlertDialog, Button, Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle, EmptyState,
  ErrorState, Input, Sheet, SheetContent, Spinner,
} from '@/components/ui'
import { cn } from '@/lib/cn'
import { useBreakpoint } from '@/lib/media'
import { toast } from '@/lib/toast'
import { addFiles, defaultFontId, lastKeys, setFallbackFont } from './actions'
import { Canvas } from './canvas/canvas'
import { setBase, useCollaboration } from './collab'
import { useActiveProfile, useAppSettings, useFontCoverage, useFonts, usePapers } from './data'
import { errText } from './ext'
import { onImport, takeImports } from './import-queue'
import { Inspector } from './inspector/inspector'
import { TextContent, TextStyle } from './inspector/text'
import { elementKey, emptyDoc, makeFlow, pagePaperRef, paperDims, hasTravel, mergeOrigin, profileOrigin, resolvePaper, variableValues } from './model'
import { LayersList, Navigator, PagesList } from './panels/navigator'
import {
  createProject, duplicateProject, LAST_KEY, overwriteServer, reloadFromServer, renameProject, saveAsTemplate, saveNow, useAutosave,
} from './project-io'
import { renderDocNow, requestElements, usePageRender, type RenderItem } from './render-engine'
import { BackgroundAlignPanel, BackgroundPagesDialog, importBackgroundInteractive } from './sheets/background-panel'
import { ExportSheet } from './sheets/export-sheet'
import { PaperSheet } from './sheets/paper-sheet'
import { PositionSheet } from './sheets/position-sheet'
import { PrintSheet } from './sheets/print-sheet'
import { ProjectsSheet } from './sheets/projects-sheet'
import { StudioShortcuts } from './shortcuts'
import { useStudio } from './store'
import {
  CanvasBar, Collaborators, CompactBar, ModeSwitch, PrimaryActions, ProjectMenu, SaveIndicator, ToolButtons, UndoRedo, type StudioCommands,
} from './toolbar'

/** Built-in templates (tpl-*) are read-only on the server (409 builtin): open a copy instead. */
function isBuiltinTemplate(p: Pick<Project, 'id'> & { builtin?: boolean }) {
  return !!p.builtin || p.id.startsWith('tpl-')
}

export default function StudioPage() {
  const { projectId } = useParams()
  const navigate = useNavigate()
  const [boot, setBoot] = React.useState<string | null>(null)

  // no id → last opened / most recent / new letter project
  React.useEffect(() => {
    if (projectId) return
    let alive = true
    ;(async () => {
      try {
        const last = localStorage.getItem(LAST_KEY)
        const list = await api.get<ProjectSummary[]>('/projects', { query: { template: 0 } })
        if (!alive) return
        const pick = (last && list.find((p) => p.id === last)) || [...list].sort((a, b) => b.updated_at - a.updated_at)[0]
        if (pick) return navigate(`/studio/${pick.id}`, { replace: true })
        const doc = emptyDoc('我的第一封信')
        doc.pages[0].elements.push({ ...makeFlow(defaultFontId(), ''), z: 0 })
        const p = await createProject(doc.name, doc)
        if (alive) navigate(`/studio/${p.id}`, { replace: true })
      } catch (e) {
        if (alive) setBoot(errText(e))
      }
    })()
    return () => {
      alive = false
    }
  }, [projectId, navigate])

  if (!projectId) {
    return (
      <Page title="创作台" padded={false}>
        <div className="flex flex-1 items-center justify-center">{boot ? <ErrorState title="无法打开创作台" error={new Error(boot)} onRetry={() => location.reload()} /> : <Spinner size={24} />}</div>
      </Page>
    )
  }
  return <Studio key={projectId} projectId={projectId} />
}

function Studio({ projectId }: { projectId: string }) {
  const navigate = useNavigate()
  const q = useQuery({
    queryKey: qk.projects.detail(projectId),
    queryFn: () => api.get<Project>(`/projects/${projectId}`),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    gcTime: 0,
  })
  const loadedId = useStudio((s) => s.project?.id)
  const canEdit = useCanEdit()
  const [copying, setCopying] = React.useState(false)
  // Opening a built-in template creates an editable copy (viewers just look at it read-only).
  React.useEffect(() => {
    if (!q.data || !isBuiltinTemplate(q.data) || !canEdit || copying) return
    setCopying(true)
    void api
      .post<Project>(`/projects/${q.data.id}/duplicate`, {})
      .then((p) => {
        void queryClient.invalidateQueries({ queryKey: qk.projects.all })
        toast.success('已基于模板创建副本', { description: `内置模板不能直接修改，现在编辑的是「${p.name}」。` })
        navigate(`/studio/${p.id}`, { replace: true })
      })
      .catch((e) => {
        setCopying(false)
        toast.error('无法复制模板', { description: errText(e) })
      })
  }, [q.data, canEdit, copying, navigate])
  React.useEffect(() => {
    if (q.data && isBuiltinTemplate(q.data) && canEdit) return
    if (q.data && useStudio.getState().project?.id !== q.data.id) {
      useStudio.getState().load(q.data)
      setBase(q.data.doc)
      localStorage.setItem(LAST_KEY, q.data.id)
      // new letter project: put the cursor straight into the body (05-review §1.2-2)
      const flow = q.data.doc.pages[0]?.elements.find((e) => e.type === 'flow_text')
      if (flow && flow.type === 'flow_text' && !flow.props.text) useStudio.setState({ selection: [flow.id], editTextOf: flow.id })
    }
  }, [q.data])
  React.useEffect(() => () => {
    void saveNow()
  }, [])

  if (q.error) {
    const notFound = isApiError(q.error) && q.error.status === 404
    return (
      <Page title="创作台" padded={false}>
        <div className="flex flex-1 items-center justify-center p-6">
          {notFound ? (
            <EmptyState
              icon={TriangleAlert}
              title="找不到这个项目"
              description="它可能已被删除。"
              action={
                <Button variant="filled" onClick={() => { localStorage.removeItem(LAST_KEY); navigate('/studio', { replace: true }) }}>
                  打开最近的项目
                </Button>
              }
            />
          ) : (
            <ErrorState error={q.error} onRetry={() => void q.refetch()} />
          )}
        </div>
      </Page>
    )
  }
  if (!q.data || loadedId !== projectId || (isBuiltinTemplate(q.data) && canEdit)) {
    return (
      <Page title="创作台" padded={false}>
        <div className="flex flex-1 items-center justify-center bg-canvas-desk">
          <Spinner size={24} label="正在打开项目" />
        </div>
      </Page>
    )
  }
  return <Editor />
}

function Editor() {
  const bp = useBreakpoint()
  const compact = bp === 'compact'
  const inspectorOpen = useUi((s) => s.inspector[bp])
  const setInspector = useUi((s) => s.setInspector)
  const project = useStudio((s) => s.project)!
  const doc = useStudio((s) => s.doc)!
  const version = useStudio((s) => s.version)
  const view = useStudio((s) => s.view)
  const saveState = useStudio((s) => s.saveState)
  const bgAlign = useStudio((s) => s.bgAlign && !!s.doc?.pages[s.view.page]?.background)
  const papers = usePapers()
  useFonts()
  const settings = useAppSettings()
  const cjk = useFontCoverage('尊敬的客户您好此致敬礼我们谢谢年月日', !settings.data?.default_font)
  React.useEffect(() => {
    const best = (cjk.data ?? []).filter((f) => !f.hidden && !(f.missing?.length)).sort((a, b) => b.glyph_count - a.glyph_count)[0]
    if (!best) return
    setFallbackFont(best.id)
    // fresh elements created before the font list arrived: give them the CJK font
    const st = useStudio.getState()
    const empty = st.doc?.pages.flatMap((p) => p.elements).filter((e) => (e.type === 'text' || e.type === 'flow_text') && !e.props.font_id && !e.props.text)
    if (empty?.length)
      st.edit((d) => {
        for (const p of d.pages) for (const e of p.elements) if ((e.type === 'text' || e.type === 'flow_text') && !e.props.font_id && !e.props.text) e.props.font_id = best.id
      }, { record: false })
  }, [cjk.data])
  const { profile } = useActiveProfile()
  const [sheet, setSheet] = React.useState<null | 'paper' | 'print' | 'export' | 'projects' | 'position' | 'template' | 'rename' | 'layers' | 'inspector' | 'text'>(null)
  const [navOpen, setNavOpen] = React.useState(true)
  const fileRef = React.useRef<HTMLInputElement>(null)
  const [accept, setAccept] = React.useState('')

  const canEdit = useCanEdit()
  React.useEffect(() => {
    useStudio.getState().setReadOnly(!canEdit)
    return () => useStudio.getState().setReadOnly(false)
  }, [canEdit])

  useAutosave()
  useCollaboration()

  const page = doc.pages[Math.min(view.page, doc.pages.length - 1)]
  const paperRef = pagePaperRef(doc, page)
  const paper = resolvePaper(paperRef, papers.data)
  const profOrigin = profileOrigin(profile?.doc as never)
  const origin = mergeOrigin(profOrigin, doc.print?.origin, page.origin)
  const originOverridden = !!(page.origin ?? doc.print?.origin)
  const workArea = hasTravel(profile?.doc.work_area) ? profile!.doc.work_area! : null
  const vars = React.useMemo(() => variableValues(doc), [doc])

  // element-local renders (keys computed synchronously so the canvas can read them this render)
  const items = React.useMemo(() => {
    const out: RenderItem[] = []
    for (const p of doc.pages) {
      const ref = pagePaperRef(doc, p)
      const pp = resolvePaper(ref, papers.data)
      for (const el of p.elements) {
        const key = elementKey(el, pp, vars)
        lastKeys.set(el.id, key)
        out.push({ key, el, paper: ref })
      }
    }
    return out
  }, [doc, papers.data, vars])
  React.useEffect(() => {
    if (papers.data) requestElements(project.id, items, vars)
  }, [items, project.id, vars, papers.data])
  usePageRender(papers.data ? project.id : null, doc, version, vars)

  // dropped / queued imports
  React.useEffect(() => {
    const run = () => {
      for (const it of takeImports()) {
        if (it.as === 'background') void importBackgroundInteractive(it.files[0])
        else void addFiles(it.files, it.as)
      }
    }
    run()
    return onImport(run)
  }, [])

  const openImport = (acc?: string) => {
    setAccept(acc ?? '.svg,.dxf,.png,.jpg,.jpeg,.webp,.gcode,.nc,.gco,.txt,.json,.pdf')
    setTimeout(() => fileRef.current?.click(), 0)
  }
  const onFiles = async (files: File[]) => {
    const proj = files.filter((f) => f.name.toLowerCase().endsWith('.json') || f.name.toLowerCase().endsWith('.zip'))
    const pdf = files.filter((f) => f.name.toLowerCase().endsWith('.pdf'))
    if (pdf.length) void importBackgroundInteractive(pdf[0])
    const rest = files.filter((f) => !proj.includes(f) && !pdf.includes(f))
    if (rest.length) void addFiles(rest)
    if (proj.length) setSheet('projects')
  }

  const cmd: StudioCommands = {
    openProjects: () => setSheet('projects'),
    openPrint: () => setSheet('print'),
    openExport: () => setSheet('export'),
    openPosition: () => setSheet('position'),
    openImport,
    openTemplate: () => setSheet('template'),
    rename: () => setSheet('rename'),
    duplicate: async () => {
      try {
        const p = await duplicateProject()
        if (p) {
          toast.success('已复制项目', { description: p.name })
          location.assign(`/studio/${p.id}`)
        }
      } catch (e) {
        toast.error('复制失败', { description: errText(e) })
      }
    },
    newProject: () => setSheet('projects'),
    preview: () => {
      const s = useStudio.getState()
      if (s.animate) return s.setAnimate(false)
      void renderDocNow(project.id, s.doc!, s.version, vars).then(() => useStudio.getState().setAnimate(true))
    },
    openInspector: () => setSheet('inspector'),
    openLayers: () => setSheet('layers'),
    openTextEdit: () => {
      const s = useStudio.getState()
      const el = s.doc?.pages[s.view.page]?.elements.find((e) => e.id === s.selection[0])
      if (compact) setSheet(el && (el.type === 'text' || el.type === 'flow_text') ? 'text' : 'inspector')
    },
  }

  const inspector = (
    <Inspector
      paper={paper}
      origin={origin}
      originOverridden={originOverridden}
      profileName={profile?.name ?? '默认'}
      workArea={workArea}
      onOpenPaper={() => setSheet('paper')}
      onOpenPosition={() => setSheet('position')}
    />
  )
  const { w: pw, h: ph } = paperDims(paper)
  const sel = useStudio((s) => s.selection)
  const editEl = sel.length === 1 ? page.elements.find((e) => e.id === sel[0]) : undefined

  return (
    <Page
      title={project.name}
      subtitle={compact ? undefined : <SaveIndicator />}
      padded={false}
      inspector={canEdit}
      toolbar={
        !canEdit ? (
          <span className="rounded-xs bg-fill px-1.5 text-footnote font-medium text-secondary-label">只读 · 你的账户只能查看</span>
        ) : compact ? null : (
          <div className="flex items-center gap-2">
            <ProjectMenu cmd={cmd} />
            {project.is_template ? <span className="rounded-xs bg-yellow/25 px-1.5 text-footnote font-medium text-label">正在编辑模板</span> : null}
            <UndoRedo />
            <span className="h-5 w-px bg-separator" />
            <ModeSwitch />
            <span className="h-5 w-px bg-separator" />
            <ToolButtons cmd={cmd} />
          </div>
        )
      }
      actions={
        <>
          {compact ? null : <Collaborators />}
          {canEdit ? <PrimaryActions cmd={cmd} compact={compact} /> : null}
        </>
      }
    >
      <StudioShortcuts cmd={cmd} />
      <input
        ref={fileRef}
        type="file"
        multiple
        hidden
        accept={accept}
        onChange={(e) => {
          const files = [...(e.currentTarget.files ?? [])]
          e.currentTarget.value = ''
          if (files.length) void onFiles(files)
        }}
      />
      <div className="absolute inset-0 flex flex-col">
        <div className="flex min-h-0 flex-1">
          {!compact ? (
            <div className={cn('mat-sidebar hairline-r relative shrink-0 overflow-hidden transition-[width] duration-[var(--dur-slow)] ease-spring', navOpen ? 'w-[var(--navigator-w)]' : 'w-0')} inert={!navOpen}>
              <div className="absolute inset-y-0 left-0 w-[var(--navigator-w)]">
                <Navigator />
              </div>
            </div>
          ) : null}
          <div className="relative min-w-0 flex-1">
            <Canvas paper={paper} origin={origin} workArea={workArea} insetBottom={compact ? 56 : 56} onRequestTextEdit={() => compact && setSheet('text')} />
            {!(compact && bgAlign) ? (
              <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center px-2">
                <CanvasBar compact={compact} />
              </div>
            ) : null}
            {!compact && !bgAlign ? (
              <button
                type="button"
                className="mat-thin absolute left-7 top-7 z-10 rounded-md px-2 py-1 text-footnote text-secondary-label shadow-sm ring-1 ring-separator/50 hover:text-label"
                onClick={() => setNavOpen(!navOpen)}
                aria-label={navOpen ? '收起页面栏' : '展开页面栏'}
              >
                {navOpen ? '‹' : '›'} 页面
              </button>
            ) : null}
            {bgAlign ? <BackgroundAlignPanel /> : null}
            {saveState === 'conflict' ? <ConflictBanner /> : null}
            <p className="sr-only">
              纸张 {pw}×{ph} 毫米
            </p>
          </div>
          {!compact && inspectorOpen && canEdit ? (
            <aside className="hairline-l w-[var(--inspector-w)] shrink-0 overflow-y-auto overscroll-contain bg-bg-elevated" aria-label="检查器">
              {inspector}
            </aside>
          ) : null}
        </div>
        {compact ? (
          <>
            <div className="mat-thick hairline-t shrink-0">
              <PagesList horizontal />
            </div>
            {canEdit ? <CompactBar cmd={cmd} /> : null}
          </>
        ) : null}
      </div>

      {/* medium: inspector as sheet when toggled */}
      {bp === 'medium' && inspectorOpen && canEdit ? (
        <Sheet open onOpenChange={(o) => setInspector(bp, o)}>
          <SheetContent title="检查器" width={340} noOverlay>
            {inspector}
          </SheetContent>
        </Sheet>
      ) : null}
      {compact ? (
        <>
          <Sheet open={sheet === 'inspector'} onOpenChange={(o) => setSheet(o ? 'inspector' : null)}>
            <SheetContent title="参数" defaultDetent="medium" noOverlay>
              {inspector}
            </SheetContent>
          </Sheet>
          <Sheet open={sheet === 'layers'} onOpenChange={(o) => setSheet(o ? 'layers' : null)}>
            <SheetContent title="图层" defaultDetent="medium">
              <LayersList />
            </SheetContent>
          </Sheet>
          <Sheet open={sheet === 'text' && !!editEl} onOpenChange={(o) => setSheet(o ? 'text' : null)}>
            <SheetContent title="编辑文字" defaultDetent="large">
              {editEl && (editEl.type === 'text' || editEl.type === 'flow_text') ? (
                <>
                  <TextContent el={editEl} autoFocus />
                  <TextStyle el={editEl} />
                </>
              ) : null}
            </SheetContent>
          </Sheet>
        </>
      ) : null}

      <PaperSheet open={sheet === 'paper'} onOpenChange={(o) => setSheet(o ? 'paper' : null)} current={paper} currentRef={paperRef} />
      <PrintSheet open={sheet === 'print'} onOpenChange={(o) => setSheet(o ? 'print' : null)} paper={paper} origin={origin} onOpenPosition={() => setSheet('position')} />
      <BackgroundPagesDialog />
      <ExportSheet open={sheet === 'export'} onOpenChange={(o) => setSheet(o ? 'export' : null)} />
      <ProjectsSheet open={sheet === 'projects'} onOpenChange={(o) => setSheet(o ? 'projects' : null)} />
      <PositionSheet open={sheet === 'position'} onOpenChange={(o) => setSheet(o ? 'position' : null)} paper={paper} origin={origin} workArea={workArea} />
      <PromptDialog
        open={sheet === 'rename'}
        title="重命名项目"
        initial={project.name}
        confirmLabel="重命名"
        onClose={() => setSheet(null)}
        onSubmit={(n) => {
          renameProject(n)
          void saveNow()
        }}
      />
      <PromptDialog
        open={sheet === 'template'}
        title="存为模板"
        description="模板保存当前的页面、纸张、原点和打印设置；之后可以从「项目与模板」里一键套用。"
        initial={`${project.name} 模板`}
        confirmLabel="保存模板"
        onClose={() => setSheet(null)}
        onSubmit={(n) => void saveAsTemplate(n).catch((e) => toast.error('保存模板失败', { description: errText(e) }))}
      />
    </Page>
  )
}

function ConflictBanner() {
  const [busy, setBusy] = React.useState(false)
  return (
    <AlertDialog open>
      <AlertDialogContent
        title="这个项目在别处被修改了"
        description="自动合并没有成功。你可以载入别处的版本（放弃这里未保存的修改），或者用这里的版本覆盖。"
        confirmLabel={busy ? '正在覆盖…' : '用这里的版本覆盖'}
        cancelLabel="载入别处的版本"
        onConfirm={async () => {
          setBusy(true)
          await overwriteServer().catch((e) => toast.error('覆盖失败', { description: errText(e) }))
          setBusy(false)
        }}
        onCancel={() => void reloadFromServer()}
      />
    </AlertDialog>
  )
}

function PromptDialog({ open, title, description, initial, confirmLabel, onClose, onSubmit }: { open: boolean; title: string; description?: string; initial: string; confirmLabel: string; onClose: () => void; onSubmit: (v: string) => void }) {
  const [v, setV] = React.useState(initial)
  React.useEffect(() => {
    if (open) setV(initial)
  }, [open, initial])
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="sm">
        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (!v.trim()) return
            onSubmit(v.trim())
            onClose()
          }}
        >
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            {description ? <p className="text-callout text-secondary-label">{description}</p> : null}
          </DialogHeader>
          <DialogBody>
            <Input autoFocus value={v} onChange={(e) => setV(e.currentTarget.value)} aria-label={title} />
          </DialogBody>
          <DialogFooter>
            <Button onClick={onClose}>取消</Button>
            <Button type="submit" variant="filled">
              {confirmLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
