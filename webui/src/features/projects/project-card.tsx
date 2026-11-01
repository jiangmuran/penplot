import {
  Copy, Download, Ellipsis, FileArchive, FolderOpen, LayoutTemplate, Pencil, Sheet as SheetIcon, Sparkles, Trash2,
} from 'lucide-react'
import * as React from 'react'
import type { ProjectSummary } from '@/api/projects'
import {
  Badge, ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger, DropdownMenu,
  DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger, IconButton,
} from '@/components/ui'
import { cn } from '@/lib/cn'
import { formatRelative } from '@/lib/format'
import { ProjectThumb } from './thumb'

export type ProjectAction = 'open' | 'use' | 'edit' | 'batch' | 'duplicate' | 'rename' | 'export' | 'export-zip' | 'save-template' | 'delete'

interface MenuEntry {
  id: ProjectAction
  label: string
  icon: React.ReactNode
  destructive?: boolean
  sepBefore?: boolean
}

export function menuFor(p: ProjectSummary): MenuEntry[] {
  const common: MenuEntry[] = [
    { id: 'batch', label: '批量生成…', icon: <SheetIcon />, sepBefore: true },
    { id: 'duplicate', label: '复制', icon: <Copy /> },
    { id: 'rename', label: '重命名…', icon: <Pencil /> },
    { id: 'export', label: '导出 JSON', icon: <Download />, sepBefore: true },
    { id: 'export-zip', label: '导出 ZIP（含资源）', icon: <FileArchive /> },
  ]
  if (p.builtin || p.id.startsWith('tpl-')) {
    // Built-in templates are read-only on the server (409 builtin): use, or duplicate to edit.
    return [
      { id: 'use', label: '使用此模板', icon: <Sparkles /> },
      { id: 'duplicate', label: '复制后编辑', icon: <Copy /> },
      { id: 'batch', label: '批量生成…', icon: <SheetIcon />, sepBefore: true },
      { id: 'export', label: '导出 JSON', icon: <Download />, sepBefore: true },
    ]
  }
  if (p.is_template) {
    return [
      { id: 'use', label: '使用此模板', icon: <Sparkles /> },
      { id: 'edit', label: '编辑模板', icon: <LayoutTemplate /> },
      ...common,
      { id: 'delete', label: '删除模板…', icon: <Trash2 />, destructive: true, sepBefore: true },
    ]
  }
  return [
    { id: 'open', label: '打开', icon: <FolderOpen /> },
    ...common,
    { id: 'save-template', label: '另存为模板…', icon: <LayoutTemplate /> },
    { id: 'delete', label: '删除…', icon: <Trash2 />, destructive: true, sepBefore: true },
  ]
}

function subtitle(p: ProjectSummary) {
  return `${formatRelative(p.updated_at)} · ${p.pages} 页`
}

export function ProjectCard({ project: p, onAction }: { project: ProjectSummary; onAction: (a: ProjectAction, p: ProjectSummary) => void }) {
  const entries = menuFor(p)
  const primary: ProjectAction = p.is_template ? 'use' : 'open'
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div className="group relative flex flex-col gap-2">
          <button
            type="button"
            onClick={() => onAction(primary, p)}
            aria-label={p.is_template ? `使用模板 ${p.name}` : `打开 ${p.name}`}
            className="focus-ring press relative block rounded-lg bg-bg-grouped-secondary p-0 shadow-sm transition-shadow hover:shadow-md"
          >
            <ProjectThumb id={p.id} name={p.name} url={p.thumb_url} template={p.is_template} className="aspect-[4/5] w-full rounded-lg" />
            {p.is_template ? (
              <span className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center gap-2 rounded-b-lg bg-gradient-to-t from-black/35 to-transparent px-2 pb-2 pt-6 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 pointer-coarse:hidden">
                <span className="rounded-full bg-accent px-3 py-1 text-footnote font-semibold text-white shadow-sm">使用</span>
              </span>
            ) : null}
          </button>
          <div className="flex items-start gap-1 px-0.5">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <p className="truncate text-headline text-label" title={p.name}>
                  {p.name}
                </p>
                {p.is_template ? (
                  <Badge tone="accent" size="md">
                    模板
                  </Badge>
                ) : null}
              </div>
              <p className="truncate text-[12px] leading-4 tabular-nums text-secondary-label">{subtitle(p)}</p>
            </div>
            <ActionsMenu project={p} entries={entries} onAction={onAction} />
          </div>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        {entries.map((e) => (
          <React.Fragment key={e.id}>
            {e.sepBefore ? <ContextMenuSeparator /> : null}
            <ContextMenuItem icon={e.icon} destructive={e.destructive} onSelect={() => onAction(e.id, p)}>
              {e.label}
            </ContextMenuItem>
          </React.Fragment>
        ))}
      </ContextMenuContent>
    </ContextMenu>
  )
}

export function ActionsMenu({
  project, entries, onAction, className,
}: { project: ProjectSummary; entries?: MenuEntry[]; onAction: (a: ProjectAction, p: ProjectSummary) => void; className?: string }) {
  const list = entries ?? menuFor(project)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton label={`“${project.name}”的更多操作`} size="sm" className={cn('-mr-1 mt-0.5', className)} noTooltip>
          <Ellipsis />
        </IconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {list.map((e) => (
          <React.Fragment key={e.id}>
            {e.sepBefore ? <DropdownMenuSeparator /> : null}
            <DropdownMenuItem icon={e.icon} destructive={e.destructive} onSelect={() => onAction(e.id, project)}>
              {e.label}
            </DropdownMenuItem>
          </React.Fragment>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function ProjectRow({ project: p, onAction }: { project: ProjectSummary; onAction: (a: ProjectAction, p: ProjectSummary) => void }) {
  const primary: ProjectAction = p.is_template ? 'use' : 'open'
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div className="flex items-center gap-3 px-3 py-2 hover:bg-quaternary-fill">
          <button type="button" onClick={() => onAction(primary, p)} className="focus-ring flex min-w-0 flex-1 items-center gap-3 rounded-md text-left">
            <ProjectThumb id={p.id} name={p.name} url={p.thumb_url} template={p.is_template} className="h-12 w-10 shrink-0 rounded-sm" />
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1.5">
                <span className="truncate text-body text-label">{p.name}</span>
                {p.is_template ? (
                  <Badge tone="accent" size="md">
                    模板
                  </Badge>
                ) : null}
              </span>
              <span className="block truncate text-footnote text-secondary-label md:hidden">{subtitle(p)}</span>
            </span>
            <span className="hidden w-16 shrink-0 text-right text-footnote tabular-nums text-secondary-label md:block">{p.pages} 页</span>
            <span className="hidden w-28 shrink-0 text-right text-footnote tabular-nums text-secondary-label md:block">{formatRelative(p.updated_at)}</span>
          </button>
          <ActionsMenu project={p} onAction={onAction} className="mt-0" />
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        {menuFor(p).map((e) => (
          <React.Fragment key={e.id}>
            {e.sepBefore ? <ContextMenuSeparator /> : null}
            <ContextMenuItem icon={e.icon} destructive={e.destructive} onSelect={() => onAction(e.id, p)}>
              {e.label}
            </ContextMenuItem>
          </React.Fragment>
        ))}
      </ContextMenuContent>
    </ContextMenu>
  )
}
