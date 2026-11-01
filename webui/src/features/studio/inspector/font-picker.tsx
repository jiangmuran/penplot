/**
 * Font picker (05-review §1.2-3): sections 最近使用 · 收藏 · 完整覆盖当前文字 · 全部; each row previews the first
 * 6 characters of the current text; "缺 N" badges from GET /fonts?covers=.
 */
import { Check, ChevronsUpDown, Star, TriangleAlert } from 'lucide-react'
import * as React from 'react'
import { api } from '@/api/client'
import type { FontSummary } from '@/api/studio'
import { Popover, PopoverContent, PopoverTrigger, SearchField, Spinner } from '@/components/ui'
import { cn } from '@/lib/cn'
import { useFontCoverage, useFonts } from '../data'

const RECENT_KEY = 'penplot.fonts.recent'
const FAV_KEY = 'penplot.fonts.favorites'
const readList = (k: string): string[] => {
  try {
    return JSON.parse(localStorage.getItem(k) ?? '[]') as string[]
  } catch {
    return []
  }
}
const writeList = (k: string, v: string[]) => {
  try {
    localStorage.setItem(k, JSON.stringify(v))
  } catch {
    /* ignore */
  }
}
export function pushRecentFont(id: string) {
  writeList(RECENT_KEY, [id, ...readList(RECENT_KEY).filter((x) => x !== id)].slice(0, 5))
}

export function sampleOf(text: string) {
  return [...new Set([...text.replace(/\{\{[^}]*\}\}/g, '')].filter((c) => c.trim()))].slice(0, 6).join('') || '见字如面'
}

export function FontPicker({ value, onChange, text, id }: { value: string | null | undefined; onChange: (id: string) => void; text: string; id?: string }) {
  const fonts = useFonts()
  const cov = useFontCoverage(text)
  const [open, setOpen] = React.useState(false)
  const [q, setQ] = React.useState('')
  const [favs, setFavs] = React.useState(() => readList(FAV_KEY))
  const missing = React.useMemo(() => new Map((cov.data ?? []).map((f) => [f.id, f.missing ?? []])), [cov.data])
  const sample = sampleOf(text)
  const all = (fonts.data ?? []).filter((f) => !f.hidden || f.id === value)
  const byId = new Map(all.map((f) => [f.id, f]))
  const cur = byId.get(value ?? '')
  const ql = q.trim().toLowerCase()
  const match = (f: FontSummary) => !ql || f.display_name.toLowerCase().includes(ql) || f.id.toLowerCase().includes(ql)
  const recent = readList(RECENT_KEY).map((x) => byId.get(x)).filter((f): f is FontSummary => !!f && match(f))
  const fav = favs.map((x) => byId.get(x)).filter((f): f is FontSummary => !!f && match(f))
  const full = cov.data ? all.filter((f) => match(f) && (missing.get(f.id)?.length ?? 0) === 0) : []
  const sections: { title: string; items: FontSummary[] }[] = ql
    ? [{ title: '搜索结果', items: all.filter(match) }]
    : [
        { title: '最近使用', items: recent },
        { title: '收藏', items: fav },
        { title: '完整覆盖当前文字', items: full.slice(0, 12) },
        { title: `全部字体 · ${all.length}`, items: all },
      ].filter((s) => s.items.length)
  const choose = (fid: string) => {
    pushRecentFont(fid)
    onChange(fid)
    setOpen(false)
  }
  const toggleFav = (fid: string) => {
    const next = favs.includes(fid) ? favs.filter((x) => x !== fid) : [fid, ...favs]
    setFavs(next)
    writeList(FAV_KEY, next)
  }
  const curMissing = missing.get(value ?? '')
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1">
      <Popover open={open} onOpenChange={(o) => { setOpen(o); if (o) setQ('') }}>
        <PopoverTrigger asChild>
          <button
            id={id}
            type="button"
            role="combobox"
            aria-expanded={open}
            aria-label="字体"
            className="focus-ring press inline-flex h-7 w-full min-w-0 items-center justify-between gap-1.5 rounded-sm bg-bg-elevated pl-2 pr-1 text-body shadow-sm pointer-coarse:h-11"
          >
            <span className={cn('truncate', !cur && 'text-secondary-label')}>{cur?.display_name ?? (fonts.isLoading ? '加载字体…' : '默认字体')}</span>
            <span className="flex size-4 shrink-0 items-center justify-center rounded-[4px] bg-accent text-white">
              <ChevronsUpDown className="size-3" strokeWidth={2.5} />
            </span>
          </button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-[340px] p-1.5">
          <SearchField autoFocus value={q} onValueChange={setQ} placeholder="搜索字体" />
          <div className="mt-1 max-h-[min(420px,60dvh)] overflow-y-auto overscroll-contain" role="listbox" aria-label="字体">
            {sections.length === 0 ? <p className="px-2 py-6 text-center text-footnote text-secondary-label">没有匹配的字体</p> : null}
            {sections.map((s) => (
              <div key={s.title} className="py-1">
                <div className="flex items-center gap-1.5 px-2 pb-1 pt-1.5 text-footnote font-semibold text-secondary-label">
                  {s.title}
                  {s.title.startsWith('完整') && cov.isFetching ? <Spinner size={12} /> : null}
                </div>
                {s.items.map((f) => {
                  const m = missing.get(f.id)
                  const sel = f.id === value
                  return (
                    <div
                      key={`${s.title}-${f.id}`}
                      role="option"
                      aria-selected={sel}
                      tabIndex={0}
                      onClick={() => choose(f.id)}
                      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), choose(f.id))}
                      className={cn('focus-ring group flex min-h-9 cursor-default items-center gap-2 rounded-md px-2 py-1 pointer-coarse:min-h-12', sel ? 'bg-accent/12' : 'hover:bg-quaternary-fill')}
                    >
                      <span className="w-4 shrink-0">{sel ? <Check className="size-3.5 text-accent" strokeWidth={2.5} /> : null}</span>
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate text-body text-label">{f.display_name}</span>
                        <img
                          src={api.url(`/fonts/${encodeURIComponent(f.id)}/sample.svg`, { text: sample, size_mm: 7 })}
                          alt={`${f.display_name} 样张`}
                          loading="lazy"
                          className="mt-0.5 h-5 max-w-full self-start object-contain object-left dark:invert"
                        />
                      </span>
                      {m && m.length ? <span className="shrink-0 rounded-xs bg-orange/15 px-1 text-footnote text-on-tint-orange">缺 {m.length}</span> : null}
                      <button
                        type="button"
                        aria-label={favs.includes(f.id) ? '取消收藏' : '收藏'}
                        onClick={(e) => {
                          e.stopPropagation()
                          toggleFav(f.id)
                        }}
                        className={cn('press shrink-0 rounded-sm p-1 pointer-coarse:p-2.5', favs.includes(f.id) ? 'text-yellow' : 'text-tertiary-label opacity-0 group-hover:opacity-100 pointer-coarse:opacity-100')}
                      >
                        <Star className="size-3.5" fill={favs.includes(f.id) ? 'currentColor' : 'none'} />
                      </button>
                    </div>
                  )
                })}
              </div>
            ))}
          </div>
        </PopoverContent>
      </Popover>
      {curMissing && curMissing.length ? (
        <span className="flex items-center gap-1 text-footnote text-on-tint-orange">
          <TriangleAlert className="size-3" />
          这款字体缺 {curMissing.length} 个字
        </span>
      ) : null}
    </div>
  )
}

/** Best covering font for `text` (fewest missing), excluding `exclude`. */
export function useBestFont(text: string, exclude?: string | null) {
  const cov = useFontCoverage(text)
  return React.useMemo(() => {
    const list = (cov.data ?? []).filter((f) => !f.hidden && f.id !== exclude)
    list.sort((a, b) => (a.missing?.length ?? 0) - (b.missing?.length ?? 0))
    return list[0] ?? null
  }, [cov.data, exclude])
}
