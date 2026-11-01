import { FileText, LayoutTemplate } from 'lucide-react'
import * as React from 'react'
import { errText } from './ext'
import { usePapers, type ProjectSummary } from '@/api/projects'
import {
  Button, Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, FormField, Input,
  Segmented, Select, Skeleton,
} from '@/components/ui'
import { cn } from '@/lib/cn'
import { ProjectThumb } from './thumb'

const RECENT_PAPERS = 'penplot.recentPapers'
export function recentPapers(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_PAPERS) ?? '[]')
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []
  } catch {
    return []
  }
}
export function rememberPaper(id: string) {
  localStorage.setItem(RECENT_PAPERS, JSON.stringify([id, ...recentPapers().filter((x) => x !== id)].slice(0, 5)))
}

/** Standard size name for dimensions in mm (either orientation), with the legacy 1 mm-short variants. */
function sizeName(w: number, h: number): { name: string; legacy: boolean } | null {
  const [a, b] = [Math.round(Math.min(w, h)), Math.round(Math.max(w, h))]
  const sizes: [string, number, number][] = [['A3', 297, 420], ['A4', 210, 297], ['A5', 148, 210], ['A6', 105, 148], ['B5', 176, 250], ['16 开', 184, 260], ['16 开', 195, 270], ['明信片', 100, 148], ['DL 信封', 110, 220]]
  for (const [n, x, y] of sizes) {
    if (a === x && b === y) return { name: n, legacy: false }
    if (Math.abs(a - x) <= 1 && Math.abs(b - y) <= 1) return { name: n, legacy: true }
  }
  return null
}

/** 「A4 · 普通边距」 + 「兼容旧软件 209×296 mm」 instead of 「A4普通边距 · 209×296」. */
export function paperLabel(p: { name: string; width_mm: number; height_mm: number }) {
  const sz = sizeName(p.width_mm, p.height_mm)
  const dims = `${Math.round(p.width_mm)}×${Math.round(p.height_mm)} mm`
  if (!sz) return { title: p.name, sub: dims }
  const rest = p.name.replace(/^(A\d|B\d|16K|16开)\s*/i, '').trim()
  return { title: rest && rest !== p.name ? `${sz.name} · ${rest}` : p.name.startsWith(sz.name) ? p.name : `${p.name}（${sz.name}）`, sub: sz.legacy ? `兼容旧软件 ${dims}` : dims }
}

/** Single text-field dialog (rename / save as template). */
export function NameDialog({
  open, onOpenChange, title, description, label = '名称', initial, confirmLabel = '保存', onSubmit,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  title: string
  description?: string
  label?: string
  initial: string
  confirmLabel?: string
  onSubmit: (name: string) => Promise<unknown>
}) {
  const [name, setName] = React.useState(initial)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  React.useEffect(() => {
    if (open) {
      setName(initial)
      setError(null)
    }
  }, [open, initial])
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    const v = name.trim()
    if (!v) return setError('名称不能为空')
    setBusy(true)
    try {
      await onSubmit(v)
      onOpenChange(false)
    } catch (err) {
      setError(errText(err))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            {description ? <DialogDescription>{description}</DialogDescription> : null}
          </DialogHeader>
          <DialogBody>
            <FormField label={label} htmlFor="name-dialog-input" error={error}>
              <Input
                id="name-dialog-input"
                autoFocus
                value={name}
                maxLength={120}
                invalid={!!error}
                aria-describedby={error ? 'name-dialog-input-error' : undefined}
                onChange={(e) => {
                  setName(e.currentTarget.value)
                  setError(null)
                }}
                onFocus={(e) => e.currentTarget.select()}
              />
            </FormField>
          </DialogBody>
          <DialogFooter>
            <Button onClick={() => onOpenChange(false)}>取消</Button>
            <Button type="submit" variant="filled" loading={busy}>
              {confirmLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function sortPapers<T extends { id: string }>(list: T[]): T[] {
  const recent = recentPapers()
  const rank = (id: string) => {
    const i = recent.indexOf(id)
    return i < 0 ? 99 : i
  }
  return [...list].sort((a, b) => rank(a.id) - rank(b.id))
}

export type NewProjectInput = { name: string; paperId?: string; templateId?: string }

/** 新建项目: blank (name + paper) or from a template. */
export function NewProjectDialog({
  open, onOpenChange, templates, templatesLoading, initialTemplateId, onCreate,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  templates: ProjectSummary[]
  templatesLoading?: boolean
  initialTemplateId?: string | null
  onCreate: (input: NewProjectInput) => Promise<unknown>
}) {
  const papers = usePapers()
  const [mode, setMode] = React.useState<'blank' | 'template'>('blank')
  const [name, setName] = React.useState('')
  const [paperId, setPaperId] = React.useState('a4-normal')
  const [templateId, setTemplateId] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (!open) return
    setMode(initialTemplateId || templates.length ? 'template' : 'blank')
    setTemplateId(initialTemplateId ?? null)
    setName('')
    setError(null)
    const recent = recentPapers()
    setPaperId(recent[0] ?? 'a4-normal')
  }, [open, initialTemplateId])

  const tpl = templates.find((t) => t.id === templateId)
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (mode === 'template' && !tpl) return setError('请选择一个模板')
    const finalName = name.trim() || (mode === 'template' && tpl ? tpl.name : '未命名项目')
    setBusy(true)
    try {
      await onCreate(mode === 'template' ? { name: finalName, templateId: tpl!.id } : { name: finalName, paperId })
      onOpenChange(false)
    } catch (err) {
      setError(errText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="md">
        <form onSubmit={submit} className="flex min-h-0 flex-col">
          <DialogHeader>
            <DialogTitle>新建项目</DialogTitle>
            <DialogDescription>从空白页面开始，或复制一个模板。</DialogDescription>
          </DialogHeader>
          <DialogBody className="flex flex-col gap-4">
            <Segmented
              block
              aria-label="创建方式"
              value={mode}
              onValueChange={(v) => {
                setMode(v)
                setError(null)
              }}
              options={[
                { value: 'template', label: '从模板', icon: LayoutTemplate },
                { value: 'blank', label: '空白项目', icon: FileText },
              ]}
            />
            <FormField label="项目名称" htmlFor="new-project-name">
              <Input
                id="new-project-name"
                autoFocus
                value={name}
                maxLength={120}
                placeholder={mode === 'template' && tpl ? tpl.name : '未命名项目'}
                onChange={(e) => setName(e.currentTarget.value)}
              />
            </FormField>
            {mode === 'blank' ? (
              <FormField label="纸张" htmlFor="new-project-paper" help="以后也可以在创作台里换纸">
                {papers.isLoading ? (
                  <Skeleton className="h-7 w-full" />
                ) : (
                  <Select
                    id="new-project-paper"
                    value={paperId}
                    onValueChange={setPaperId}
                    className="w-full"
                    options={sortPapers<{ id: string; name: string; width_mm: number; height_mm: number }>(papers.data ?? [{ id: 'a4-normal', name: 'A4普通边距', width_mm: 209, height_mm: 296 }]).map((p) => {
                      const l = paperLabel(p)
                      return {
                        value: p.id,
                        label: (
                          <span className="flex items-baseline gap-2">
                            <span>{l.title}</span>
                            <span className="text-footnote opacity-70">{l.sub}</span>
                          </span>
                        ),
                      }
                    })}
                  />
                )}
              </FormField>
            ) : (
              <fieldset className="flex flex-col gap-1.5">
                <legend className="mb-1.5 text-footnote font-medium text-secondary-label">模板</legend>
                {templatesLoading ? (
                  <div className="grid grid-cols-3 gap-2">
                    {[0, 1, 2].map((i) => <Skeleton key={i} className="aspect-[4/5] rounded-md" />)}
                  </div>
                ) : templates.length === 0 ? (
                  <p className="rounded-md bg-quaternary-fill px-3 py-4 text-center text-footnote text-secondary-label">
                    还没有模板。在项目卡片的菜单里选「另存为模板」就能做一个。
                  </p>
                ) : (
                  <div role="radiogroup" aria-label="模板" className="grid max-h-72 grid-cols-3 gap-2 overflow-y-auto p-0.5 sm:grid-cols-4">
                    {templates.map((t) => (
                      <button
                        key={t.id}
                        type="button"
                        role="radio"
                        aria-checked={templateId === t.id}
                        onClick={() => {
                          setTemplateId(t.id)
                          setError(null)
                        }}
                        className={cn(
                          'focus-ring press flex flex-col gap-1 rounded-lg p-1.5 text-left transition-colors hover:bg-quaternary-fill',
                          templateId === t.id && 'bg-accent/10 shadow-[inset_0_0_0_2px_rgb(var(--accent))]',
                        )}
                      >
                        <ProjectThumb id={t.id} name={t.name} url={t.thumb_url} template className="aspect-[4/5] w-full" />
                        <span className="truncate px-0.5 text-footnote text-label">{t.name}</span>
                      </button>
                    ))}
                  </div>
                )}
              </fieldset>
            )}
            {error ? (
              <p role="alert" className="text-footnote text-red">
                {error}
              </p>
            ) : null}
          </DialogBody>
          <DialogFooter>
            <Button onClick={() => onOpenChange(false)}>取消</Button>
            <Button type="submit" variant="filled" loading={busy}>
              创建并打开
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
