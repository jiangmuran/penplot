/** Projects & templates sheet inside the studio: open recent, new (blank / letter / from template), import JSON. */
import { FilePlus2, FileUp, LayoutTemplate, ScrollText } from 'lucide-react'
import * as React from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '@/api/client'
import { qk, queryClient } from '@/api/query'
import type { ProjectImportResult } from '@/api/studio'
import { Button, ErrorState, SearchField, Segmented, SheetContent, Sheet, SkeletonList } from '@/components/ui'
import { cn } from '@/lib/cn'
import { formatRelative } from '@/lib/format'
import { toast } from '@/lib/toast'
import { useProjectList } from '../data'
import { errText } from '../ext'
import { emptyDoc, makeFlow } from '../model'
import { createProject, saveNow } from '../project-io'
import { useStudio } from '../store'
import { defaultFontId } from '../actions'

export function ProjectsSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [tab, setTab] = React.useState<'recent' | 'templates'>('recent')
  const [q, setQ] = React.useState('')
  const list = useProjectList(tab === 'templates', q)
  const navigate = useNavigate()
  const current = useStudio((s) => s.project?.id)
  const fileRef = React.useRef<HTMLInputElement>(null)
  const openProject = async (id: string) => {
    await saveNow()
    onOpenChange(false)
    navigate(`/studio/${id}`)
  }
  const create = async (kind: 'blank' | 'letter' | { template: string; name: string }) => {
    try {
      await saveNow()
      let p
      if (typeof kind === 'object') p = await createProject(`${kind.name}（副本）`, undefined, kind.template)
      else {
        const doc = emptyDoc(kind === 'letter' ? '新信笺' : '未命名项目')
        if (kind === 'letter') doc.pages[0].elements.push({ ...makeFlow(defaultFontId(), ''), z: 0 })
        p = await createProject(doc.name, doc)
      }
      onOpenChange(false)
      navigate(`/studio/${p.id}`)
    } catch (e) {
      toast.error('新建失败', { description: errText(e) })
    }
  }
  const importJson = async (f: File) => {
    try {
      const fd = new FormData()
      fd.append('file', f, f.name)
      const r = await api.post<ProjectImportResult>('/projects/import', fd, { timeoutMs: 120_000 })
      void queryClient.invalidateQueries({ queryKey: qk.projects.all })
      if (r.missing_fonts.length) toast.warning(`缺少 ${r.missing_fonts.length} 个字体`, { description: `${r.missing_fonts.join('、')}，将使用默认字体。` })
      onOpenChange(false)
      navigate(`/studio/${r.project.id}`)
    } catch (e) {
      toast.error('导入失败', { description: errText(e) })
    }
  }
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent title="项目与模板" width={440}>
        <div className="flex flex-col gap-3 px-4 pb-4">
          <div className="grid grid-cols-3 gap-2">
            <Tile icon={ScrollText} label="写一封信" onClick={() => void create('letter')} />
            <Tile icon={FilePlus2} label="空白画布" onClick={() => void create('blank')} />
            <Tile icon={FileUp} label="导入 JSON" onClick={() => fileRef.current?.click()} />
          </div>
          <input ref={fileRef} type="file" accept=".json,.penplot.json,.zip" hidden onChange={(e) => e.currentTarget.files?.[0] && void importJson(e.currentTarget.files[0])} />
          <div className="flex items-center gap-2">
            <Segmented value={tab} onValueChange={setTab} options={[{ value: 'recent', label: '最近' }, { value: 'templates', label: '模板' }]} size="sm" />
            <SearchField value={q} onValueChange={setQ} className="min-w-0 flex-1" />
          </div>
          {list.isLoading ? <SkeletonList rows={5} /> : null}
          {list.error ? <ErrorState error={list.error} onRetry={() => void list.refetch()} /> : null}
          {list.data && !list.data.length ? (
            <p className="py-8 text-center text-footnote text-secondary-label">{tab === 'templates' ? '还没有模板。在项目菜单里选「存为模板」。' : '还没有项目'}</p>
          ) : null}
          <ul className="flex flex-col">
            {list.data?.map((p) => (
              <li key={p.id}>
                <div className={cn('flex items-center gap-3 rounded-md px-2 py-2', p.id === current ? 'bg-accent/10' : 'hover:bg-quaternary-fill')}>
                  <span className="flex h-12 w-9 shrink-0 items-center justify-center overflow-hidden rounded-xs bg-canvas-paper shadow-paper">
                    {p.thumb_url ? <img src={p.thumb_url} alt="" className="h-full w-full object-contain" loading="lazy" /> : <LayoutTemplate className="size-4 text-tertiary-label" />}
                  </span>
                  <button type="button" className="min-w-0 flex-1 text-left" onClick={() => (tab === 'templates' ? void create({ template: p.id, name: p.name }) : void openProject(p.id))}>
                    <span className="block truncate text-headline text-label">{p.name}</span>
                    <span className="block text-footnote text-secondary-label">
                      {p.pages} 页 · {formatRelative(p.updated_at)}
                      {p.id === current ? ' · 正在编辑' : ''}
                    </span>
                  </button>
                  {tab === 'templates' ? (
                    <Button size="sm" variant="tinted" onClick={() => void create({ template: p.id, name: p.name })}>
                      使用
                    </Button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        </div>
      </SheetContent>
    </Sheet>
  )
}

function Tile({ icon: Icon, label, onClick }: { icon: typeof FilePlus2; label: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="press focus-ring flex flex-col items-center gap-1.5 rounded-lg bg-fill/60 px-2 py-3 text-footnote font-medium text-label hover:bg-fill">
      <Icon className="size-5 text-accent" />
      {label}
    </button>
  )
}
