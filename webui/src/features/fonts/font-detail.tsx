import { useMutation, useQuery } from '@tanstack/react-query'
import {
  ChevronDown, CircleCheck, Download, Eye, EyeOff, FileType, Pencil, Star, Trash2, TriangleAlert, Type,
} from 'lucide-react'
import * as React from 'react'
import { api, errorMessage, isApiError } from '@/api/client'
import { downloadFrom } from '@/api/download'
import {
  FONT_SOURCE_LABEL, fontSampleUrl, useFontCoverage, useFontDetail, usePatchFont, type FontDetail, type FontSummary,
} from '@/api/fonts'
import { qk, queryClient } from '@/api/query'
import type { components } from '@/api/schema'
import {
  Badge, Button, Card, CardHeader, Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger, EmptyState,
  ErrorState, GroupedList, Input, ListRow, NumberField, ProgressBar, Skeleton, Slider, Textarea,
} from '@/components/ui'
import { cn } from '@/lib/cn'
import { formatBytes, formatRelative } from '@/lib/format'
import { toast } from '@/lib/toast'
import { GlyphBrowser } from './glyph-browser'
import { INCOMPLETE_GLYPHS, markFontUsed, useFontPrefs } from './prefs'
import { softDeleteFont } from './soft-delete'

type AppSettings = components['schemas']['AppSettings']

export const DEFAULT_SAMPLE = '永和九年，岁在癸丑。The quick brown fox 0123'
/** GB2312 level 1 + 2 hanzi count, used as the reference for the CJK coverage meter. */
const GB2312_HANZI = 6763

function useDebounced<T>(v: T, ms = 350) {
  const [d, setD] = React.useState(v)
  React.useEffect(() => {
    const t = setTimeout(() => setD(v), ms)
    return () => clearTimeout(t)
  }, [v, ms])
  return d
}

export function useAppSettings() {
  return useQuery({ queryKey: qk.settings, queryFn: () => api.get<AppSettings>('/settings'), staleTime: 60_000 })
}

function useSetDefaultFont() {
  return useMutation({
    mutationFn: (id: string | null) => api.patch<AppSettings>('/settings', { default_font: id }),
    meta: { errorTitle: '设置默认字体失败' },
    onSuccess: (s) => {
      queryClient.setQueryData(qk.settings, s)
      void queryClient.invalidateQueries({ queryKey: qk.settings })
    },
  })
}

export function FontDetailView({
  id, summary, coverText, onDeleted, compact,
}: { id: string; summary?: FontSummary; coverText: string; onDeleted: () => void; compact?: boolean }) {
  const q = useFontDetail(id)
  const font: (FontSummary & Partial<FontDetail>) | undefined = q.data ?? summary

  if (q.isError && !summary) {
    if (isApiError(q.error) && q.error.status === 404) {
      return <EmptyState icon={Type} title="找不到该字体" description="它可能已被删除或隐藏。" />
    }
    return <ErrorState error={q.error} onRetry={() => void q.refetch()} />
  }
  if (!font) return <DetailSkeleton />
  return <DetailBody font={font} detail={q.data} coverText={coverText} onDeleted={onDeleted} compact={compact} />
}

function DetailSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-busy aria-label="加载中">
      <div className="flex items-center gap-4">
        <Skeleton className="size-16 rounded-xl" />
        <div className="flex flex-1 flex-col gap-2">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-3 w-64" />
        </div>
      </div>
      <Skeleton className="h-48 rounded-lg" />
      <Skeleton className="h-32 rounded-lg" />
    </div>
  )
}

function DetailBody({
  font, detail, coverText, onDeleted, compact,
}: { font: FontSummary & Partial<FontDetail>; detail?: FontDetail; coverText: string; onDeleted: () => void; compact?: boolean }) {
  const settings = useAppSettings()
  const setDefault = useSetDefaultFont()
  const patch = usePatchFont()
  const [renaming, setRenaming] = React.useState(false)
  const isDefault = settings.data?.default_font === font.id
  const protectedFont = font.source === 'bundled' || font.source === 'builtin'

  const download = async (to: 'psf' | 'gfont') => {
    const base = font.display_name || font.id
    try {
      await downloadFrom(`/fonts/${encodeURIComponent(font.id)}/convert`, `${base}.${to}`, { method: 'POST', body: { to } })
      markFontUsed(font.id)
      toast.success(`已下载「${base}」`)
    } catch (e) {
      toast.error('下载字体文件失败', { description: `${errorMessage(e)}。稍后再试；如果一直失败，到「系统」页查看服务日志。` })
    }
  }

  const fav = useFontPrefs((s) => s.favorites.includes(font.id))
  const toggleFavorite = useFontPrefs((s) => s.toggleFavorite)

  const setHidden = (hidden: boolean, undoable = true) =>
    patch.mutate(
      { id: font.id, hidden },
      {
        onSuccess: () =>
          toast({
            title: hidden ? `已隐藏「${font.display_name}」` : `已显示「${font.display_name}」`,
            description: hidden ? '它不会再出现在字体选择里，可以在「已隐藏」中找回。' : undefined,
            level: 'success',
            duration: undoable ? 10_000 : undefined,
            action: undoable ? { label: '撤销', onClick: () => setHidden(!hidden, false) } : undefined,
          }),
      },
    )

  const remove = () => softDeleteFont(font, onDeleted)

  return (
    <div className="flex flex-col gap-5">
      {/* header */}
      <div className="flex flex-col gap-3">
        <div className="flex items-start gap-4">
          <FontTile fontId={font.id} size={compact ? 56 : 64} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="truncate text-title2 text-label">{font.display_name}</h2>
              {fav ? <Star className="size-4 shrink-0 fill-yellow text-yellow" aria-label="已收藏" /> : null}
              {isDefault ? <Badge tone="accent">默认</Badge> : null}
              {font.glyph_count < INCOMPLETE_GLYPHS ? <Badge tone="orange">不完整</Badge> : null}
              {font.hidden ? <Badge tone="gray" icon={EyeOff}>已隐藏</Badge> : null}
            </div>
            <p className="mt-0.5 text-subheadline tabular-nums text-secondary-label">
              {font.glyph_count.toLocaleString('zh-CN')} 字 · {formatBytes(font.size_bytes)} · {FONT_SOURCE_LABEL[font.source] ?? font.source}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant={fav ? 'tinted' : 'gray'}
            icon={<Star className={cn(fav && 'fill-current')} />}
            aria-pressed={fav}
            onClick={() => {
              const on = toggleFavorite(font.id)
              toast.success(on ? `已收藏「${font.display_name}」` : `已取消收藏「${font.display_name}」`, { ephemeral: true })
            }}
          >
            {fav ? '已收藏' : '收藏'}
          </Button>
          <Button
            variant={isDefault ? 'gray' : 'tinted'}
            icon={<CircleCheck />}
            loading={setDefault.isPending}
            onClick={() =>
              setDefault.mutate(isDefault ? null : font.id, {
                onSuccess: () => {
                  if (!isDefault) markFontUsed(font.id)
                  toast.success(isDefault ? '已取消默认字体' : `「${font.display_name}」已设为默认字体`)
                },
              })
            }
          >
            {isDefault ? '取消默认' : '设为默认'}
          </Button>
          <Button variant="gray" icon={<Pencil />} onClick={() => setRenaming(true)}>
            重命名
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="gray" icon={<Download />}>
                导出
                <ChevronDown className="-mr-1 size-3.5 opacity-60" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuLabel>下载字体文件</DropdownMenuLabel>
              <DropdownMenuItem icon={<FileType />} onSelect={() => void download(font.format)}>
                原始文件
              </DropdownMenuItem>
              <DropdownMenuItem icon={<FileType />} onSelect={() => void download(font.format === 'gfont' ? 'psf' : 'gfont')}>
                {font.format === 'gfont' ? '转成通用单线格式' : '转成 gfont 格式'}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button variant="gray" icon={font.hidden ? <Eye /> : <EyeOff />} loading={patch.isPending && patch.variables?.hidden !== undefined} onClick={() => setHidden(!font.hidden)}>
            {font.hidden ? '显示' : '隐藏'}
          </Button>
          {!protectedFont ? (
            <Button variant="destructive-plain" icon={<Trash2 />} onClick={remove}>
              删除
            </Button>
          ) : null}
        </div>
      </div>

      <SampleCard font={font} coverText={coverText} />

      {detail ? <CoverageCard detail={detail} /> : <Skeleton className="h-28 rounded-lg" />}

      <Card>
        <CardHeader title="字形" subtitle="点按字形查看大图与码位" />
        {detail ? <GlyphBrowser fontId={font.id} refSize={detail.ref_size} glyphCount={font.glyph_count} /> : <Skeleton className="m-4 h-60" />}
      </Card>

      <GroupedList header="信息">
        <ListRow label="文件名" value={<span className="select-all">{font.filename}</span>} />
        <ListRow label="ID" value={<span className="select-all font-mono text-footnote">{font.id}</span>} />
        <ListRow label="大小" value={formatBytes(font.size_bytes)} />
        <ListRow label="来源" value={FONT_SOURCE_LABEL[font.source] ?? font.source} />
        {detail?.mtime ? <ListRow label="修改时间" value={formatRelative(detail.mtime)} /> : null}
        {detail?.header?.version != null ? <ListRow label="文件版本" value={String(detail.header.version)} /> : null}
        {detail?.header?.name ? <ListRow label="头部名称" value={detail.header.name} /> : null}
        {detail?.header?.b || detail?.header?.a ? (
          <ListRow label="作者字段" value={[detail.header.b, detail.header.a].filter(Boolean).join(' · ')} />
        ) : null}
      </GroupedList>
      {protectedFont ? <p className="-mt-3 px-4 text-footnote text-secondary-label">内置字体不能删除，可以隐藏。厂商字体有版权，不要对外分发。</p> : null}

      <RenameDialog
        open={renaming}
        onOpenChange={setRenaming}
        initial={font.display_name}
        pending={patch.isPending}
        onSubmit={(name) =>
          patch.mutate(
            { id: font.id, display_name: name },
            {
              onSuccess: () => {
                setRenaming(false)
                toast.success('已重命名')
              },
            },
          )
        }
      />
    </div>
  )
}

/** First two visible characters of the user's text (falls back to 「永和」). */
export function tileText(text?: string) {
  const chars = [...(text ?? '')].filter((c) => c.trim() && !/[，。、；：！？,.;:!?\s]/.test(c)).slice(0, 2)
  return chars.length ? chars.join('') : '永和'
}

/** Small sample thumbnail rendered by the server (lazy). */
export function FontTile({ fontId, size = 56, className, text }: { fontId: string; size?: number; className?: string; text?: string }) {
  const sample = tileText(text)
  const [failed, setFailed] = React.useState(false)
  return (
    <span
      className={cn('flex shrink-0 items-center justify-center overflow-hidden rounded-lg bg-canvas-paper shadow-[0_0_0_0.5px_rgb(var(--separator)/var(--separator-a))]', className)}
      style={{ width: size, height: size }}
      aria-hidden
    >
      {failed ? (
        <Type className="size-1/2 text-secondary-label" strokeWidth={1.5} />
      ) : (
        <img
          src={fontSampleUrl(fontId, sample, 10)}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          onError={() => setFailed(true)}
          className="max-h-[78%] max-w-[86%] object-contain"
        />
      )}
    </span>
  )
}

function SampleCard({ font, coverText }: { font: FontSummary; coverText: string }) {
  const [text, setText] = React.useState(coverText || DEFAULT_SAMPLE)
  React.useEffect(() => {
    if (coverText) setText(coverText)
  }, [coverText])
  const [size, setSize] = React.useState(8)
  const dText = useDebounced(text.slice(0, 200))
  const dSize = useDebounced(size, 200)
  const cov = useFontCoverage(font.id, dText)
  const missing = React.useMemo(() => new Set(cov.data?.missing ?? []), [cov.data])
  const [imgState, setImgState] = React.useState<'loading' | 'ok' | 'error'>('loading')
  const paperRef = React.useRef<HTMLDivElement>(null)
  const [paperW, setPaperW] = React.useState(170)
  React.useLayoutEffect(() => {
    const el = paperRef.current
    if (!el) return
    // CSS mm = 96/25.4 px; wrap the sample to the visible paper width (minus 16px padding each side).
    const update = () => setPaperW(Math.max(30, Math.min(260, Math.floor(((el.clientWidth - 32) * 25.4) / 96 / 5) * 5)))
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const src = dText.trim() ? fontSampleUrl(font.id, dText, dSize, paperW) : null
  React.useEffect(() => setImgState('loading'), [src])
  const textId = React.useId()

  return (
    <Card>
      <CardHeader
        title="样张"
        subtitle="服务器按实际字形生成；缺字会画成方框"
        actions={
          missing.size ? (
            <Badge tone="orange" icon={TriangleAlert}>
              缺 {missing.size} 字
            </Badge>
          ) : cov.data && dText ? (
            <Badge tone="green">全部覆盖</Badge>
          ) : null
        }
      />
      <div className="flex flex-col gap-3 px-4 pb-4">
        <label htmlFor={textId} className="sr-only">
          测试文字
        </label>
        <Textarea
          id={textId}
          value={text}
          maxLength={200}
          rows={2}
          onChange={(e) => setText(e.currentTarget.value)}
          placeholder="输入测试文字"
          className="min-h-14 text-body"
        />
        {missing.size ? (
          <p className="text-callout leading-relaxed text-secondary-label" aria-label={`缺字：${[...missing].join('、')}`}>
            {[...dText].map((c, i) =>
              missing.has(c) ? (
                <mark key={i} className="rounded-[3px] bg-red/15 px-px font-medium text-on-tint-red">
                  {c}
                </mark>
              ) : (
                <span key={i}>{c}</span>
              ),
            )}
          </p>
        ) : null}
        <div className="flex items-center gap-3">
          <span className="shrink-0 text-footnote text-secondary-label">字号（mm）</span>
          <Slider value={[size]} min={3} max={24} step={0.5} onValueChange={([v]) => setSize(v)} aria-label="样张字号" className="max-w-56" />
          <NumberField value={size} onChange={setSize} min={3} max={24} step={0.5} stepper={false} className="w-16 pointer-coarse:w-20" aria-label="样张字号（毫米）" />
        </div>
        <div ref={paperRef} className="relative min-h-24 overflow-x-auto rounded-lg bg-canvas-paper p-4 shadow-paper">
          {src ? (
            <img
              key={src}
              src={src}
              alt={`「${font.display_name}」样张：${dText}`}
              className={cn('block max-w-none transition-opacity duration-[var(--dur-fast)]', imgState === 'loading' && 'opacity-40')}
              onLoad={() => setImgState('ok')}
              onError={() => setImgState('error')}
            />
          ) : (
            <p className="text-callout text-secondary-label">输入文字以预览</p>
          )}
          {imgState === 'error' && src ? <p className="text-callout text-on-tint-orange">样张生成失败</p> : null}
          {imgState === 'loading' && src ? <ProgressBar value={null} label="生成样张" className="absolute inset-x-0 bottom-0 h-0.5 rounded-none bg-transparent" /> : null}
        </div>
      </div>
    </Card>
  )
}

function CoverageCard({ detail }: { detail: FontDetail }) {
  const c = detail.coverage_summary
  const pct = Math.min(100, (100 * c.cjk) / GB2312_HANZI)
  const tiles: [string, number][] = [
    ['总字数', c.total],
    ['汉字', c.cjk],
    ['拉丁', c.latin],
    ['符号', c.symbols],
  ]
  return (
    <Card>
      <CardHeader title="覆盖" />
      <div className="grid grid-cols-4 gap-px px-4">
        {tiles.map(([k, v]) => (
          <div key={k} className="flex flex-col">
            <span className="text-footnote text-secondary-label">{k}</span>
            <span className="text-title3 tabular-nums text-label">{v.toLocaleString('zh-CN')}</span>
          </div>
        ))}
      </div>
      <div className="px-4 pb-4 pt-3">
        <div className="mb-1 flex items-baseline justify-between text-footnote">
          <span className="text-secondary-label">常用字 + 次常用字（6,763 字）中的汉字</span>
          <span className="tabular-nums text-label">{pct.toFixed(1)}%</span>
        </div>
        <ProgressBar value={pct} tone={pct >= 99 ? 'green' : pct >= 50 ? 'accent' : 'orange'} label="汉字覆盖率" valueText={`${pct.toFixed(1)}%`} />
      </div>
    </Card>
  )
}

function RenameDialog({
  open, onOpenChange, initial, pending, onSubmit,
}: { open: boolean; onOpenChange: (v: boolean) => void; initial: string; pending: boolean; onSubmit: (name: string) => void }) {
  const [name, setName] = React.useState(initial)
  React.useEffect(() => {
    if (open) setName(initial)
  }, [open, initial])
  const valid = name.trim().length > 0 && name.trim().length <= 64
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (valid) onSubmit(name.trim())
          }}
        >
          <DialogHeader>
            <DialogTitle>重命名字体</DialogTitle>
            <DialogDescription>只修改显示名称，不影响文件和已有项目。</DialogDescription>
          </DialogHeader>
          <DialogBody>
            <Input autoFocus value={name} onChange={(e) => setName(e.currentTarget.value)} aria-label="显示名称" maxLength={64} inputSize="lg" invalid={!valid} />
          </DialogBody>
          <DialogFooter>
            <Button variant="gray" onClick={() => onOpenChange(false)}>
              取消
            </Button>
            <Button type="submit" variant="filled" disabled={!valid || name.trim() === initial} loading={pending}>
              保存
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

