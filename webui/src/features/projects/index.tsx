/**
 * 项目与模板 /projects (02-ux §3.4): recent projects + templates, create / import / duplicate / rename /
 * export / save-as-template / delete, and the batch (mail-merge) sheet.
 */
import { ArrowDownUp, FileUp, FolderOpen, LayoutGrid, LayoutTemplate, List, PenLine, Plus, SearchX } from 'lucide-react'
import * as React from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Page } from '@/app/page'
import { pickFile } from '@/api/download'
import {
  createProject, duplicateProject, exportProject, invalidateProjects, renameProject, saveAsTemplate, useProjects,
  type ProjectSummary,
} from '@/api/projects'
import {
  Button, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem,
  DropdownMenuSeparator, DropdownMenuTrigger, EmptyState, ErrorState, IconButton, SearchField, Segmented, Skeleton,
} from '@/components/ui'
import { useIsCompact } from '@/lib/media'
import { toast } from '@/lib/toast'
import { BatchSheet } from './batch-sheet'
import { NameDialog, NewProjectDialog, rememberPaper, type NewProjectInput } from './dialogs'
import { errParts } from './ext'
import { importProjectFiles } from './import-files'
import { ProjectCard, ProjectRow, type ProjectAction } from './project-card'
import { softDeleteProject, useSoftDeleted } from './soft-delete'

type Tab = 'recent' | 'templates'
type Sort = 'updated' | 'name'
type View = 'grid' | 'list'

const VIEW_KEY = 'penplot.projects.view'

const ACTION_ERROR: Record<ProjectAction, string> = {
  open: '没能打开项目',
  edit: '没能打开模板',
  use: '没能用这个模板新建项目',
  batch: '没能打开批量生成',
  duplicate: '没能复制项目',
  rename: '没能重命名',
  export: '没能导出项目',
  'export-zip': '没能导出项目',
  'save-template': '没能另存为模板',
  delete: '没能删除',
}

export default function ProjectsPage() {
  const navigate = useNavigate()
  const compact = useIsCompact()
  const [params, setParams] = useSearchParams()
  const tab: Tab = params.get('tab') === 'templates' ? 'templates' : 'recent'
  const setTab = (t: Tab) => setParams(t === 'templates' ? { tab: t } : {}, { replace: true })
  const [q, setQ] = React.useState('')
  const [sort, setSort] = React.useState<Sort>('updated')
  const [view, setViewState] = React.useState<View>(() => (localStorage.getItem(VIEW_KEY) === 'list' ? 'list' : 'grid'))
  const setView = (v: View) => {
    setViewState(v)
    localStorage.setItem(VIEW_KEY, v)
  }

  const projects = useProjects({ template: 0 })
  const templates = useProjects({ template: 1 })
  const active = tab === 'templates' ? templates : projects

  const hidden = useSoftDeleted((s) => s.hidden)
  const items = React.useMemo(() => {
    const needle = q.trim().toLowerCase()
    const list = (active.data ?? []).filter((p) => !hidden[p.id] && (tab === 'templates' ? p.is_template : !p.is_template))
    const filtered = needle ? list.filter((p) => p.name.toLowerCase().includes(needle)) : list
    return [...filtered].sort((a, b) => (sort === 'name' ? a.name.localeCompare(b.name, 'zh-CN') : b.updated_at - a.updated_at))
  }, [active.data, q, sort, tab, hidden])

  // ---- dialogs
  const [newOpen, setNewOpen] = React.useState(false)
  const [newTemplateId, setNewTemplateId] = React.useState<string | null>(null)
  const [nameDialog, setNameDialog] = React.useState<{ kind: 'rename' | 'template'; project: ProjectSummary } | null>(null)
  const [batchFor, setBatchFor] = React.useState<ProjectSummary | null>(null)

  const openNew = (templateId: string | null = null) => {
    setNewTemplateId(templateId)
    setNewOpen(true)
  }

  const create = async (input: NewProjectInput) => {
    const p = input.templateId
      ? await createProject({ name: input.name, from_template_id: input.templateId })
      : await createProject({
          name: input.name,
          doc: { version: 1, name: input.name, paper: { paper_id: input.paperId ?? 'a4-normal' }, pages: [{ id: 'p1', elements: [] }] },
        })
    if (input.paperId) rememberPaper(input.paperId)
    void invalidateProjects()
    navigate(`/studio/${p.id}`)
  }

  /** Empty-state shortcut (05-review §3.9): a letter template if there is one, else a letter with sample text. */
  const firstLetter = async () => {
    try {
      const tpl = (templates.data ?? []).find((t) => /信|书|letter/i.test(t.name))
      const p = tpl
        ? await createProject({ name: '我的第一封信', from_template_id: tpl.id })
        : await createProject({
            name: '我的第一封信',
            doc: {
              version: 1,
              name: '我的第一封信',
              paper: { paper_id: 'a4-normal' },
              pages: [
                {
                  id: 'p1',
                  elements: [
                    {
                      id: 'e1',
                      type: 'flow_text',
                      name: '正文',
                      props: {
                        text: '尊敬的客户：\n\n您好！感谢您一直以来的支持。本月起我们的营业时间调整为每天九点至十八点，周末照常营业。\n\n如有疑问，欢迎随时联系我们。\n\n此致\n敬礼',
                      },
                    },
                  ],
                },
              ],
            },
          })
      void invalidateProjects()
      navigate(`/studio/${p.id}`)
    } catch (e) {
      const m = errParts(e, '没能创建项目')
      toast.error(m.title, { description: m.description })
    }
  }

  const importFiles = async () => {
    const files = await pickFile('.json,.zip,application/json,application/zip', true)
    if (!files) return
    const id = await importProjectFiles(files)
    if (id && files.length === 1) navigate(`/studio/${id}`)
  }

  const onAction = async (a: ProjectAction, p: ProjectSummary) => {
    try {
      switch (a) {
        case 'open':
        case 'edit':
          navigate(`/studio/${p.id}`)
          break
        case 'use': {
          const created = await createProject({ name: p.name, from_template_id: p.id })
          void invalidateProjects()
          navigate(`/studio/${created.id}`)
          break
        }
        case 'batch':
          setBatchFor(p)
          break
        case 'duplicate': {
          const d = await duplicateProject(p.id)
          void invalidateProjects()
          if (p.builtin || p.id.startsWith('tpl-')) {
            // "复制后编辑": go straight to the editable copy
            toast.success(`已复制为“${d.name}”`)
            navigate(`/studio/${d.id}`)
          } else toast.success(`已复制为“${d.name}”`, { action: { label: '打开', onClick: () => navigate(`/studio/${d.id}`) } })
          break
        }
        case 'rename':
          setNameDialog({ kind: 'rename', project: p })
          break
        case 'save-template':
          setNameDialog({ kind: 'template', project: p })
          break
        case 'export':
        case 'export-zip':
          await exportProject(p.id, p.name, a === 'export-zip')
          toast.success('已导出', { description: p.name })
          break
        case 'delete':
          softDeleteProject(p)
          break
      }
    } catch (e) {
      const m = errParts(e, ACTION_ERROR[a])
      toast.error(m.title, { description: m.description })
    }
  }

  const sortMenu = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton label="排序与显示">
          <ArrowDownUp />
        </IconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>排序</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={sort} onValueChange={(v) => setSort(v as Sort)}>
          <DropdownMenuRadioItem value="updated">修改时间</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="name">名称</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>显示</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={view} onValueChange={(v) => setView(v as View)}>
          <DropdownMenuRadioItem value="grid">图标</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="list">列表</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )

  const actions = compact ? (
    <>
      {sortMenu}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <IconButton label="新建">
            <Plus />
          </IconButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem icon={<Plus />} onSelect={() => openNew()}>
            新建项目
          </DropdownMenuItem>
          <DropdownMenuItem icon={<LayoutTemplate />} onSelect={() => setTab('templates')}>
            从模板开始
          </DropdownMenuItem>
          <DropdownMenuItem icon={<FileUp />} onSelect={importFiles}>
            导入 JSON / ZIP
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  ) : (
    <>
      <Segmented
        size="sm"
        aria-label="显示方式"
        value={view}
        onValueChange={setView}
        options={[
          { value: 'grid', icon: LayoutGrid, ariaLabel: '图标视图' },
          { value: 'list', icon: List, ariaLabel: '列表视图' },
        ]}
      />
      {sortMenu}
      <Button variant="gray" icon={<FileUp />} onClick={importFiles}>
        导入
      </Button>
      <Button variant="filled" icon={<Plus />} onClick={() => openNew()}>
        新建项目
      </Button>
    </>
  )

  const renderTabs = (block = false) => (
    <Segmented
      block={block}
      aria-label="项目类别"
      value={tab}
      onValueChange={setTab}
      options={[
        { value: 'recent', label: compact ? '最近' : `最近${projects.data ? ` ${projects.data.filter((p) => !p.is_template).length}` : ''}` },
        { value: 'templates', label: compact ? '模板' : `模板${templates.data ? ` ${templates.data.length}` : ''}` },
      ]}
    />
  )

  return (
    <Page
      title="项目与模板"
      toolbar={
        compact ? undefined : (
          <>
            {renderTabs()}
            <SearchField value={q} onValueChange={setQ} placeholder="搜索项目" className="w-56" aria-label="搜索项目" />
          </>
        )
      }
      actions={actions}
    >
      {compact ? (
        <div className="mb-4 flex flex-col gap-3">
          <SearchField value={q} onValueChange={setQ} placeholder="搜索" aria-label="搜索项目" />
          {renderTabs(true)}
        </div>
      ) : null}

      {active.isLoading ? (
        <GridSkeleton />
      ) : active.error ? (
        <ErrorState error={active.error} onRetry={() => active.refetch()} />
      ) : items.length === 0 ? (
        q ? (
          <EmptyState icon={SearchX} title="没有匹配的结果" description={`没有名称包含“${q}”的${tab === 'templates' ? '模板' : '项目'}。`} />
        ) : tab === 'templates' ? (
          <EmptyState
            icon={LayoutTemplate}
            title="还没有模板"
            description="模板是可以反复用的项目，里面可以写 {{收件人}} 这样的变量，用来批量写信封、贺卡。在项目菜单里选「另存为模板」。"
            action={<Button onClick={() => setTab('recent')}>查看项目</Button>}
          />
        ) : (
          <EmptyState
            icon={FolderOpen}
            title="还没有项目"
            description="一个项目就是一张或几张要写的纸：纸张、文字和图形都在里面，在创作台里会自动保存。"
            action={
              <div className="flex flex-col items-center gap-2">
                <Button variant="filled" size="lg" icon={<PenLine />} onClick={firstLetter}>
                  写第一封信
                </Button>
                <Button variant="plain" icon={<LayoutTemplate />} onClick={() => (templates.data?.length ? setTab('templates') : openNew())}>
                  从模板开始
                </Button>
              </div>
            }
          />
        )
      ) : view === 'grid' ? (
        <div className="grid grid-cols-2 gap-x-4 gap-y-5 sm:grid-cols-[repeat(auto-fill,minmax(168px,1fr))]">
          {tab === 'recent' && !q && !compact ? <NewTile onClick={() => openNew()} /> : null}
          {items.map((p) => (
            <ProjectCard key={p.id} project={p} onAction={onAction} />
          ))}
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg bg-bg-grouped-secondary shadow-sm [&>*+*]:hairline-t" role="list" aria-label={tab === 'templates' ? '模板' : '项目'}>
          <div className="hidden items-center gap-3 px-3 py-1.5 text-footnote font-medium text-secondary-label md:flex" aria-hidden>
            <span className="w-10" />
            <span className="flex-1">名称</span>
            <span className="w-16 text-right">页数</span>
            <span className="w-28 text-right">修改时间</span>
            <span className="w-6" />
          </div>
          {items.map((p) => (
            <div role="listitem" key={p.id}>
              <ProjectRow project={p} onAction={onAction} />
            </div>
          ))}
        </div>
      )}

      <NewProjectDialog
        open={newOpen}
        onOpenChange={setNewOpen}
        templates={templates.data ?? []}
        templatesLoading={templates.isLoading}
        initialTemplateId={newTemplateId}
        onCreate={create}
      />
      <NameDialog
        open={nameDialog?.kind === 'rename'}
        onOpenChange={(o) => !o && setNameDialog(null)}
        title={nameDialog?.project.is_template ? '重命名模板' : '重命名项目'}
        initial={nameDialog?.project.name ?? ''}
        onSubmit={async (name) => {
          await renameProject(nameDialog!.project.id, name)
          void invalidateProjects()
          toast.success('已重命名')
        }}
      />
      <NameDialog
        open={nameDialog?.kind === 'template'}
        onOpenChange={(o) => !o && setNameDialog(null)}
        title="存为模板"
        description="模板会复制当前项目的纸张、页面和元素；使用模板时会生成新的项目。"
        label="模板名称"
        initial={nameDialog ? `${nameDialog.project.name} 模板` : ''}
        confirmLabel="存为模板"
        onSubmit={async (name) => {
          await saveAsTemplate(nameDialog!.project.id, name)
          void invalidateProjects()
          toast.success(`已存为模板“${name}”`, { action: { label: '查看', onClick: () => setTab('templates') } })
        }}
      />
      <BatchSheet project={batchFor} onOpenChange={(o) => !o && setBatchFor(null)} />
    </Page>
  )
}

function NewTile({ onClick }: { onClick: () => void }) {
  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        onClick={onClick}
        className="focus-ring press flex aspect-[4/5] w-full flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-separator text-secondary-label transition-colors hover:bg-quaternary-fill hover:text-accent"
      >
        <Plus className="size-8" strokeWidth={1.5} />
        <span className="text-subheadline font-medium">新建项目</span>
      </button>
      <p className="invisible px-0.5 text-subheadline" aria-hidden>
        &nbsp;
      </p>
    </div>
  )
}

function GridSkeleton() {
  return (
    <div role="status" aria-label="加载中" className="grid grid-cols-2 gap-x-4 gap-y-5 sm:grid-cols-[repeat(auto-fill,minmax(168px,1fr))]">
      {Array.from({ length: 8 }, (_, i) => (
        <div key={i} className="flex flex-col gap-2">
          <Skeleton className="aspect-[4/5] w-full rounded-lg" />
          <Skeleton className="h-3.5 w-3/4" />
          <Skeleton className="h-3 w-1/2" />
        </div>
      ))}
    </div>
  )
}
