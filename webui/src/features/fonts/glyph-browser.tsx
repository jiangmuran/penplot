import { Copy, Grid3x3 } from 'lucide-react'
import * as React from 'react'
import { isApiError } from '@/api/client'
import { useGlyphPages, useGlyphsForChunks, type GlyphInfo } from '@/api/fonts'
import { Button, EmptyState, ErrorState, Popover, PopoverContent, PopoverTrigger, SearchField, Segmented, Skeleton, Spinner } from '@/components/ui'
import { VirtualGrid } from '@/features/console/virtual-list'
import { cn } from '@/lib/cn'
import { useIsCompact } from '@/lib/media'
import { toast } from '@/lib/toast'
import { GlyphSvg, cpLabel } from './glyph'
import { chunkChars, commonChars } from './prefs'

function useDebounced<T>(v: T, ms = 300) {
  const [d, setD] = React.useState(v)
  React.useEffect(() => {
    const t = setTimeout(() => setD(v), ms)
    return () => clearTimeout(t)
  }, [v, ms])
  return d
}

export function GlyphBrowser({ fontId, refSize, glyphCount }: { fontId: string; refSize: number; glyphCount: number }) {
  const [find, setFind] = React.useState('')
  const text = useDebounced(find.trim())
  const [mode, setMode] = React.useState<'common' | 'all'>('common')
  const commonChunks = React.useMemo(() => chunkChars(commonChars(), 300), [])
  const useCommon = mode === 'common' && !text && commonChunks.length > 0
  const qAll = useGlyphPages(useCommon ? null : fontId, text || undefined)
  const qCommon = useGlyphsForChunks(useCommon ? fontId : null, 'common-gb1', commonChunks)
  const q = useCommon ? qCommon : qAll
  const compact = useIsCompact()
  const glyphs = React.useMemo(() => q.data?.pages.flatMap((p) => p.glyphs) ?? [], [q.data])
  const commonDone = useCommon && !qCommon.hasNextPage && !qCommon.isFetching
  const commonTotal = commonChars().length
  const total = useCommon ? commonTotal : (qAll.data?.pages[0]?.total ?? glyphCount)
  const missing = React.useMemo(() => {
    if (!text) return []
    const have = new Set(glyphs.map((g) => g.char))
    return [...new Set([...text].filter((c) => c.trim() && !have.has(c)))]
  }, [text, glyphs])

  const loadMore = React.useCallback(() => {
    if (q.hasNextPage && !q.isFetchingNextPage) void q.fetchNextPage()
  }, [q])
  // 常用字 chunks are small: keep loading in the background so the "缺 N 字" count is right.
  React.useEffect(() => {
    if (useCommon && qCommon.hasNextPage && !qCommon.isFetchingNextPage && !qCommon.isError) void qCommon.fetchNextPage()
  }, [useCommon, qCommon])

  return (
    <div className="flex flex-col">
      <div className="flex flex-wrap items-center gap-2 px-4 pb-3">
        <Segmented
          aria-label="字形范围"
          value={mode}
          onValueChange={setMode}
          options={[
            { value: 'common', label: `常用字` },
            { value: 'all', label: '全部' },
          ]}
        />
        <SearchField value={find} onValueChange={setFind} placeholder="查找字（输入文字）" className="min-w-0 flex-1 sm:max-w-56" aria-label="查找字形" />
        <span className="ml-auto text-footnote tabular-nums text-secondary-label">
          {text
            ? `找到 ${glyphs.length} 个`
            : useCommon
              ? commonDone
                ? `常用字 ${glyphs.length.toLocaleString('zh-CN')} / ${commonTotal.toLocaleString('zh-CN')}${glyphs.length < commonTotal ? `，缺 ${(commonTotal - glyphs.length).toLocaleString('zh-CN')} 字` : ''}`
                : `已载入 ${glyphs.length.toLocaleString('zh-CN')} / ${commonTotal.toLocaleString('zh-CN')}`
              : `已载入 ${glyphs.length.toLocaleString('zh-CN')} / ${total.toLocaleString('zh-CN')}`}
          {q.isFetching ? <Spinner size={12} className="ml-1.5 inline-block align-[-1px]" /> : null}
        </span>
      </div>
      {missing.length ? (
        <p className="px-4 pb-2 text-footnote text-on-tint-orange">
          这个字体缺少：<span className="font-medium tracking-wider">{missing.join(' ')}</span>
        </p>
      ) : null}
      <div className="hairline-t">
        {q.isPending ? (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(64px,1fr))] gap-2 p-4" aria-busy>
            {Array.from({ length: 24 }, (_, i) => (
              <Skeleton key={i} className="h-[72px] rounded-md" />
            ))}
          </div>
        ) : q.isError ? (
          isApiError(q.error) && (q.error.status === 404 || q.error.status === 501) ? (
            <EmptyState icon={Grid3x3} title="字形浏览尚不可用" description={q.error.message} />
          ) : (
            <ErrorState error={q.error} onRetry={() => void q.refetch()} />
          )
        ) : (
          <VirtualGrid
            count={glyphs.length}
            minItemWidth={compact ? 56 : 64}
            rowHeight={compact ? 66 : 72}
            gap={6}
            className={cn('mx-4 my-3 overscroll-auto', compact ? 'h-[44dvh]' : 'h-[420px]')}
            onEndReached={loadMore}
            role="list"
            aria-label="字形"
            empty={<EmptyState icon={Grid3x3} title={text ? '这个字体里没有这些字' : '没有字形'} className="py-8" />}
            renderItem={(i) => <GlyphCell g={glyphs[i]} refSize={refSize} />}
          />
        )}
      </div>
    </div>
  )
}

function GlyphCell({ g, refSize }: { g: GlyphInfo; refSize: number }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          role="listitem"
          aria-label={`${g.char} ${cpLabel(g.cp)}`}
          className="focus-ring press group flex size-full flex-col items-center justify-center rounded-md bg-quaternary-fill text-label transition-colors hover:bg-tertiary-fill data-[state=open]:bg-accent/15 data-[state=open]:text-accent"
        >
          <GlyphSvg d={g.path_d} refSize={refSize} className="size-10" strokeWidth={1.3} />
          <span className="mt-0.5 text-caption leading-none text-tertiary-label tabular-nums group-data-[state=open]:text-accent">{g.cp.toString(16).toUpperCase()}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-64">
        <div className="flex aspect-square items-center justify-center rounded-lg bg-canvas-paper text-ink shadow-paper">
          <GlyphSvg d={g.path_d} refSize={refSize} className="size-[85%]" strokeWidth={2.2} title={`字形 ${g.char}`} />
        </div>
        <div className="mt-3 flex items-center gap-3">
          <span className="text-title1 leading-none text-label">{g.char}</span>
          <dl className="grid flex-1 grid-cols-[auto_1fr] gap-x-2 text-footnote">
            <dt className="text-secondary-label">码位</dt>
            <dd className="font-mono tabular-nums text-label">{cpLabel(g.cp)}</dd>
            <dt className="text-secondary-label">字宽</dt>
            <dd className="tabular-nums text-label">{g.w.toFixed(1)}</dd>
          </dl>
          <Button
            size="sm"
            variant="gray"
            icon={<Copy />}
            onClick={() => {
              void navigator.clipboard?.writeText(g.char).then(
                () => toast.success(`已复制「${g.char}」`, { ephemeral: true }),
                () => toast.error('复制失败'),
              )
            }}
          >
            复制
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
