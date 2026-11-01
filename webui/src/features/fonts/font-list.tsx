import { ChevronRight, EyeOff, Star } from 'lucide-react'
import * as React from 'react'
import type { FontSummary } from '@/api/fonts'
import { Badge, Skeleton } from '@/components/ui'
import { cn } from '@/lib/cn'
import { FontTile, tileText } from './font-detail'
import { INCOMPLETE_GLYPHS } from './prefs'

export function CoverageBadge({ missing }: { missing: string[] | null | undefined }) {
  if (missing == null) return null
  if (!missing.length) return <Badge tone="green">全覆盖</Badge>
  return (
    <Badge tone="orange" title={`缺：${missing.join(' ')}`}>
      缺 {missing.length} 字
    </Badge>
  )
}

/** 「覆盖常用字 98%」 (floor, so 99.9 never reads as 100). */
export function commonPctText(missing: number | undefined, total: number) {
  if (missing == null || !total) return null
  const pct = missing === 0 ? 100 : Math.min(99, Math.floor((100 * (total - missing)) / total))
  return `覆盖常用字 ${pct}%`
}

export interface FontRowInfo {
  font: FontSummary
  /** missing count of the 常用字 set */
  commonMissing?: number
  commonTotal: number
  favorite?: boolean
  isDefault?: boolean
}

export function FontRow({
  info, selected, onSelect, compact, sampleText,
}: { info: FontRowInfo; selected?: boolean; onSelect: () => void; compact?: boolean; sampleText: string }) {
  const { font, favorite, isDefault } = info
  const incomplete = font.glyph_count < INCOMPLETE_GLYPHS
  const pct = commonPctText(info.commonMissing, info.commonTotal)
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected ? 'true' : undefined}
      className={cn(
        'focus-ring group flex w-full items-center gap-3 text-left transition-colors',
        compact
          ? 'min-h-[72px] px-4 py-2 active:bg-tertiary-fill'
          : 'h-[72px] rounded-lg px-2 hover:bg-quaternary-fill aria-[current=true]:bg-accent/12 aria-[current=true]:hover:bg-accent/15',
        font.hidden && 'opacity-60',
      )}
    >
      <FontTile fontId={font.id} size={56} text={tileText([...sampleText].filter((c) => !font.missing?.includes(c)).join(''))} />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className={cn('truncate text-body font-medium text-label', selected && !compact && 'text-accent')}>{font.display_name}</span>
          {favorite ? <Star className="size-3.5 shrink-0 fill-yellow text-yellow" aria-label="已收藏" /> : null}
          {font.hidden ? <EyeOff className="size-3.5 shrink-0 text-secondary-label" aria-label="已隐藏" /> : null}
        </span>
        <span className="mt-0.5 flex items-center gap-1.5 text-footnote tabular-nums text-secondary-label">
          {isDefault ? <Badge tone="accent" size="sm">默认</Badge> : null}
          {incomplete ? (
            <Badge tone="orange" size="sm" title={`只有 ${font.glyph_count} 个字，大部分文字写不出来`}>
              不完整
            </Badge>
          ) : null}
          <span className="truncate">
            {pct ?? `${font.glyph_count.toLocaleString('zh-CN')} 字`}
            {pct ? <span className="text-secondary-label"> · {font.glyph_count.toLocaleString('zh-CN')} 字</span> : null}
          </span>
        </span>
      </span>
      <CoverageBadge missing={font.missing} />
      {compact ? <ChevronRight className="size-4 shrink-0 text-tertiary-label" aria-hidden /> : null}
    </button>
  )
}

export function FontListSkeleton({ rows = 8, compact }: { rows?: number; compact?: boolean }) {
  return (
    <div role="status" aria-label="加载中" className={cn('flex flex-col', compact && 'overflow-hidden rounded-lg bg-bg-grouped-secondary shadow-sm')}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex h-[72px] items-center gap-3 px-2">
          <Skeleton className="size-14 rounded-lg" />
          <div className="flex flex-1 flex-col gap-2">
            <Skeleton className="h-3.5" style={{ width: `${55 - (i % 4) * 8}%` }} />
            <Skeleton className="h-3 w-32" />
          </div>
        </div>
      ))}
    </div>
  )
}

export const FontList = React.memo(function FontList({
  rows, selectedId, onSelect, compact, sampleText,
}: { rows: FontRowInfo[]; selectedId: string | null; onSelect: (id: string) => void; compact?: boolean; sampleText: string }) {
  if (compact) {
    return (
      <ul className="overflow-hidden rounded-lg bg-bg-grouped-secondary shadow-sm [&>li+li]:hairline-t" aria-label="字体列表">
        {rows.map((r) => (
          <li key={r.font.id}>
            <FontRow info={r} compact sampleText={sampleText} onSelect={() => onSelect(r.font.id)} />
          </li>
        ))}
      </ul>
    )
  }
  return (
    <ul className="flex flex-col gap-0.5" aria-label="字体列表">
      {rows.map((r) => (
        <li key={r.font.id}>
          <FontRow info={r} selected={r.font.id === selectedId} sampleText={sampleText} onSelect={() => onSelect(r.font.id)} />
        </li>
      ))}
    </ul>
  )
})
