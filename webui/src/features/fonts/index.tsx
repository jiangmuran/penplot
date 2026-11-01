/** 字库 /fonts (02-ux §3.6, 01 §1, 03 §4.2). */
import { ChevronLeft, EyeOff, FileType2, FolderOpen, History, MoreHorizontal, Plus, RefreshCw, ScanText, Star, Type } from 'lucide-react'
import * as React from 'react'
import { useSearchParams } from 'react-router-dom'
import { useShallow } from 'zustand/react/shallow'
import { errorMessage, isApiError } from '@/api/client'
import { pickFile } from '@/api/download'
import { reindexFonts, useCoverageOf, useFonts, type FontSummary } from '@/api/fonts'
import { Page } from '@/app/page'
import {
  Button, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger, EmptyState, ErrorState,
  IconButton, Input, SearchField, Segmented,
} from '@/components/ui'
import { cn } from '@/lib/cn'
import { useIsCompact } from '@/lib/media'
import { toast } from '@/lib/toast'
import { FontDetailView, useAppSettings } from './font-detail'
import { FontList, FontListSkeleton, type FontRowInfo } from './font-list'
import { INCOMPLETE_GLYPHS, chunkChars, commonChars, useFontPrefs } from './prefs'
import { isDeletePending } from './soft-delete'
import { FONT_ACCEPT, useFontsUi } from './store'
import { FontTaskRows } from './task-rows'
import { TtfConvertSheet } from './ttf-sheet'
import { installFontFiles } from './upload'

type Filter = 'all' | 'favorites' | 'recent' | 'hidden'

function useDebounced<T>(v: T, ms = 300) {
  const [d, setD] = React.useState(v)
  React.useEffect(() => {
    const t = setTimeout(() => setD(v), ms)
    return () => clearTimeout(t)
  }, [v, ms])
  return d
}

export default function FontsPage() {
  const compact = useIsCompact()
  const [params, setParams] = useSearchParams()
  const selectedId = params.get('font')
  const [q, setQ] = React.useState('')
  const [filter, setFilter] = React.useState<Filter>('all')
  const [cover, setCover] = React.useState('')
  const dq = useDebounced(q)
  const dCover = useDebounced(cover.trim().slice(0, 200), 400)
  const openTtf = useFontsUi((s) => s.openTtf)
  const addTask = useFontsUi((s) => s.addTask)
  const settings = useAppSettings()

  const fonts = useFonts({
    q: dq,
    covers: dCover || undefined,
    hidden: filter === 'hidden',
  })
  const { favorites, recent } = useFontPrefs(useShallow((s) => ({ favorites: s.favorites, recent: s.recent })))
  const common = React.useMemo(() => commonChars(), [])
  const commonChunks = React.useMemo(() => chunkChars(common), [common])
  const commonCov = useCoverageOf('common-gb1', commonChunks)
  const sampleText = dCover

  const list = React.useMemo(() => {
    let l: FontSummary[] = (fonts.data ?? []).filter((f) => !isDeletePending(f.id))
    if (filter === 'hidden') l = l.filter((f) => f.hidden)
    if (filter === 'favorites') l = l.filter((f) => favorites.includes(f.id))
    if (filter === 'recent') l = recent.map((id) => l.find((f) => f.id === id)).filter((f): f is FontSummary => !!f)
    const incomplete = (f: FontSummary) => (f.glyph_count < INCOMPLETE_GLYPHS ? 1 : 0)
    if (filter !== 'recent') {
      l = [...l].sort(
        (a, b) =>
          incomplete(a) - incomplete(b) ||
          (dCover ? (a.missing?.length ?? 0) - (b.missing?.length ?? 0) : 0) ||
          a.display_name.localeCompare(b.display_name, 'zh-CN'),
      )
    }
    return l
  }, [fonts.data, filter, dCover, favorites, recent])
  const rows: FontRowInfo[] = React.useMemo(
    () =>
      list.map((font) => ({
        font,
        commonMissing: commonCov.data?.[font.id],
        commonTotal: common.length,
        favorite: favorites.includes(font.id),
        isDefault: settings.data?.default_font === font.id,
      })),
    [list, commonCov.data, common.length, favorites, settings.data?.default_font],
  )
  const onlyBuiltin = !!fonts.data && filter === 'all' && !dq && fonts.data.length > 0 && fonts.data.every((f) => f.source === 'builtin')

  const select = React.useCallback(
    (id: string | null, replace = false) => {
      setParams(
        (p) => {
          const n = new URLSearchParams(p)
          if (id) n.set('font', id)
          else n.delete('font')
          return n
        },
        { replace },
      )
    },
    [setParams],
  )

  // ?convert=1 (from the drop handler) opens the TTF sheet.
  React.useEffect(() => {
    if (params.get('convert') === '1') {
      if (!useFontsUi.getState().ttfOpen) openTtf(useFontsUi.getState().ttfFile)
      setParams(
        (p) => {
          const n = new URLSearchParams(p)
          n.delete('convert')
          return n
        },
        { replace: true },
      )
    }
  }, [params, setParams, openTtf])

  // Regular: keep a selection.
  React.useEffect(() => {
    if (compact || !list.length) return
    if (!selectedId) select(list[0].id, true)
  }, [compact, list, selectedId, select])

  const importFonts = async () => {
    const files = await pickFile(FONT_ACCEPT, true)
    if (!files) return
    const id = await installFontFiles(files)
    if (id) select(id)
  }
  const reindex = async () => {
    try {
      const r = await reindexFonts()
      addTask({ id: r.task_id, label: '重建字库索引', kind: 'reindex' })
    } catch (e) {
      toast.error('没能重建字库索引', { description: `${errorMessage(e)}。稍后再试。` })
    }
  }

  const selectedSummary = list.find((f) => f.id === selectedId) ?? fonts.data?.find((f) => f.id === selectedId)
  const filterSeg = (
    <Segmented
      aria-label="筛选"
      block={compact}
      value={filter}
      onValueChange={setFilter}
      options={[
        { value: 'all', label: '全部' },
        { value: 'favorites', label: '收藏' },
        { value: 'recent', label: '最近用过' },
        { value: 'hidden', label: '已隐藏' },
      ]}
    />
  )
  const coverField = (
    <Input
      value={cover}
      onChange={(e) => setCover(e.currentTarget.value)}
      leading={<ScanText />}
      placeholder="检查文字覆盖，如：龘靐齉"
      aria-label="检查文字覆盖：输入文字，按缺字数排序"
      maxLength={200}
      className="[&_input]:bg-tertiary-fill [&_input]:shadow-none"
    />
  )

  // ---------- compact: detail pushed ----------
  if (compact && selectedId) {
    return (
      <Page title={selectedSummary?.display_name ?? '字体'} largeTitle={false}>
        <Button variant="plain" className="-ml-2 mb-2 self-start" icon={<ChevronLeft />} onClick={() => select(null)}>
          字库
        </Button>
        <FontDetailView id={selectedId} summary={selectedSummary} coverText={dCover} onDeleted={() => select(null, true)} compact />
        <TtfConvertSheet sampleText={dCover} />
      </Page>
    )
  }

  const body = fonts.isPending ? (
    <FontListSkeleton compact={compact} />
  ) : fonts.isError ? (
    isApiError(fonts.error) && (fonts.error.status === 404 || fonts.error.status === 501) ? (
      <EmptyState icon={Type} title="字库尚不可用" description={fonts.error.message} />
    ) : (
      <ErrorState error={fonts.error} onRetry={() => void fonts.refetch()} />
    )
  ) : list.length === 0 ? (
    filter === 'favorites' && !dq ? (
      <EmptyState icon={Star} title="还没有收藏的字体" description="在字体详情里点「收藏」，常用的字体就会出现在这里，创作台的字体选择里也会排在前面。" />
    ) : filter === 'recent' && !dq ? (
      <EmptyState icon={History} title="还没有用过的字体" description="在创作台写过字、设为默认或下载过的字体会出现在这里（最多 5 个）。" />
    ) : filter === 'hidden' && !dq ? (
      <EmptyState icon={EyeOff} title="没有隐藏的字体" description="不想在字体选择里看到的字体，可以在详情里隐藏。" />
    ) : dq ? (
      <EmptyState icon={Type} title="没有匹配的字体" description={`没有名字包含「${dq}」的字体。换个关键词试试。`} />
    ) : (
      <EmptyState
        icon={Type}
        title="字库里还没有字体"
        description="把单线字体文件拖到这里，或者把电脑里的 TTF 字体转成单线字。"
        action={
          <div className="flex flex-wrap justify-center gap-2">
            <Button variant="filled" icon={<Plus />} onClick={() => void importFonts()}>
              导入字体文件
            </Button>
            <Button variant="gray" icon={<FileType2 />} onClick={() => openTtf()}>
              转换 TTF…
            </Button>
          </div>
        }
      />
    )
  ) : (
    <>
      {onlyBuiltin ? (
        <p className={cn('mb-2 rounded-lg bg-blue/10 px-3 py-2.5 text-footnote text-secondary-label', compact && 'mx-0')}>
          现在只有内置字体。导入单线字体文件，或者把电脑里的 TTF 字体转成单线字，就能写出更像手写的效果。
        </p>
      ) : null}
      <FontList rows={rows} selectedId={selectedId} onSelect={(id) => select(id)} compact={compact} sampleText={sampleText} />
    </>
  )

  const actions = compact ? (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton label="添加字体" variant="ghost">
          <Plus />
        </IconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem icon={<FolderOpen />} onSelect={() => void importFonts()}>
          导入字体文件…
        </DropdownMenuItem>
        <DropdownMenuItem icon={<FileType2 />} onSelect={() => openTtf()}>
          TTF 转手写单线…
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem icon={<RefreshCw />} onSelect={() => void reindex()}>
          重建索引
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  ) : (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <IconButton label="更多">
            <MoreHorizontal />
          </IconButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem icon={<RefreshCw />} onSelect={() => void reindex()}>
            重建字库索引
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Button variant="gray" icon={<FileType2 />} onClick={() => openTtf()}>
        转换 TTF…
      </Button>
      <Button variant="filled" icon={<Plus />} onClick={() => void importFonts()}>
        导入字体
      </Button>
    </>
  )

  const toolbar = compact ? (
    <SearchField value={q} onValueChange={setQ} placeholder="搜索字体" className="w-full min-w-40" aria-label="搜索字体" />
  ) : (
    <div className="flex items-center gap-2">
      <SearchField value={q} onValueChange={setQ} placeholder="搜索字体" className="w-52" aria-label="搜索字体" />
      {filterSeg}
    </div>
  )

  if (compact) {
    return (
      <Page title="字库" toolbar={toolbar} actions={actions}>
        <div className="flex flex-col gap-3">
          {filterSeg}
          {coverField}
          <FontTaskRows />
          {fonts.data && !fonts.isPending ? (
            <p className="px-4 text-footnote text-secondary-label">
              {list.length} 个字体{dCover ? ' · 按缺字数排序' : ''}
            </p>
          ) : null}
          {body}
        </div>
        <TtfConvertSheet sampleText={dCover} />
      </Page>
    )
  }

  return (
    <Page title="字库" toolbar={toolbar} actions={actions} padded={false} className="h-full">
      <div className="flex min-h-0 flex-1">
        <aside className="flex w-[360px] shrink-0 flex-col hairline-r bg-bg-grouped" aria-label="字体">
          <div className="flex flex-col gap-2 px-3 pb-2 pt-3">
            {coverField}
            <FontTaskRows />
            <p className={cn('px-1 text-footnote text-secondary-label', !fonts.data && 'invisible')}>
              {list.length} 个字体{dCover ? ' · 按缺字数排序' : ''}
              {fonts.isFetching && !fonts.isPending ? ' · 更新中…' : ''}
            </p>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pb-4">{body}</div>
        </aside>
        <section className="min-w-0 flex-1 overflow-y-auto overscroll-contain" aria-label="字体详情">
          <div className="mx-auto w-full max-w-[760px] px-6 py-6">
            {selectedId ? (
              <FontDetailView key={selectedId} id={selectedId} summary={selectedSummary} coverText={dCover} onDeleted={() => select(null, true)} />
            ) : fonts.isPending ? null : list.length ? null : (
              <EmptyState icon={Type} title="未选择字体" description="从左侧列表选择一个字体查看详情。" />
            )}
          </div>
        </section>
      </div>
      <TtfConvertSheet sampleText={dCover} />
    </Page>
  )
}
