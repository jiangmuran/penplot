/**
 * Fonts API (03 §4.2). Pages-agent addition.
 *
 *   const { data } = useFonts({ q, covers })
 *   const detail = useFontDetail(id)
 *   const glyphs = useGlyphPages(id)                    // infinite, 200 per page
 *   fontSampleUrl(id, '永和九年', 8)                     // <img src>
 */
import { keepPreviousData, useInfiniteQuery, useMutation, useQuery } from '@tanstack/react-query'
import type { components } from './schema'
import { api } from './client'
import { qk, queryClient } from './query'
import type { TaskRef } from './types'

type S = components['schemas']
export type FontSummary = S['FontSummary']
export type FontDetail = S['FontDetail']
export type GlyphInfo = S['GlyphInfo']
export type GlyphPage = S['GlyphPage']
export type FontCoverage = S['FontCoverage']

export interface FontListParams {
  q?: string
  covers?: string
  format?: 'gfont' | 'psf'
  source?: string
  hidden?: boolean
}

export function useFonts(params: FontListParams) {
  const p = {
    q: params.q?.trim() || undefined,
    covers: params.covers || undefined,
    format: params.format,
    source: params.source,
    hidden: params.hidden || undefined,
  }
  return useQuery({
    queryKey: qk.fonts.list(p),
    queryFn: ({ signal }) => api.get<FontSummary[]>('/fonts', { query: p, signal }),
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  })
}

export function useFontDetail(id: string | null | undefined) {
  return useQuery({
    queryKey: qk.fonts.detail(id ?? '-'),
    queryFn: ({ signal }) => api.get<FontDetail>(`/fonts/${encodeURIComponent(id!)}`, { signal }),
    enabled: !!id,
    staleTime: 60_000,
  })
}

export function useFontCoverage(id: string | null | undefined, text: string) {
  return useQuery({
    queryKey: ['fonts', 'coverage', id ?? '-', text],
    queryFn: ({ signal }) => api.get<FontCoverage>(`/fonts/${encodeURIComponent(id!)}/coverage`, { query: { text }, signal }),
    enabled: !!id && text.length > 0,
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  })
}

export const GLYPH_PAGE = 200

export function useGlyphPages(id: string | null | undefined, text?: string) {
  return useInfiniteQuery({
    queryKey: ['fonts', 'glyphs', id ?? '-', text ?? ''],
    queryFn: ({ pageParam, signal }) =>
      api.get<GlyphPage>(`/fonts/${encodeURIComponent(id!)}/glyphs`, {
        query: { from: pageParam, count: GLYPH_PAGE, text: text || undefined },
        signal,
      }),
    initialPageParam: 0,
    getNextPageParam: (last) => last.next_from ?? undefined,
    enabled: !!id,
    staleTime: 5 * 60_000,
  })
}

/** Glyphs for an explicit char list, fetched chunk by chunk (each chunk ≤ 500 chars). */
export function useGlyphsForChunks(id: string | null | undefined, key: string, chunks: string[]) {
  return useInfiniteQuery({
    queryKey: ['fonts', 'glyphs-chunks', id ?? '-', key],
    queryFn: ({ pageParam, signal }) =>
      api.get<GlyphPage>(`/fonts/${encodeURIComponent(id!)}/glyphs`, { query: { text: chunks[pageParam], count: 500 }, signal }),
    initialPageParam: 0,
    getNextPageParam: (_last, pages) => (pages.length < chunks.length ? pages.length : undefined),
    enabled: !!id && chunks.length > 0,
    staleTime: 5 * 60_000,
  })
}

/**
 * Per-font coverage of a large char set (e.g. 常用字), merged from several `?covers=` requests so the
 * URL stays short. Returns id → number of missing chars.
 */
export function useCoverageOf(key: string, chunks: string[]) {
  return useQuery({
    queryKey: ['fonts', 'coverage-of', key],
    queryFn: async ({ signal }) => {
      const lists = await Promise.all(chunks.map((c) => api.get<FontSummary[]>('/fonts', { query: { covers: c, hidden: true }, signal })))
      const missing: Record<string, number> = {}
      for (const l of lists) for (const f of l) missing[f.id] = (missing[f.id] ?? 0) + (f.missing?.length ?? 0)
      return missing
    },
    enabled: chunks.length > 0,
    staleTime: 10 * 60_000,
  })
}

export function fontSampleUrl(id: string, text: string, sizeMm: number, widthMm?: number) {
  return api.url(`/fonts/${encodeURIComponent(id)}/sample.svg`, { text, size_mm: sizeMm, width_mm: widthMm })
}


function invalidateFonts() {
  return queryClient.invalidateQueries({ queryKey: qk.fonts.all })
}

export function usePatchFont() {
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string; display_name?: string; hidden?: boolean }) =>
      api.patch<FontSummary>(`/fonts/${encodeURIComponent(id)}`, body),
    meta: { errorTitle: '更新字体失败' },
    onSuccess: () => void invalidateFonts(),
  })
}


export interface TtfConvertOptions {
  name?: string
  mode: 'skeleton' | 'outline'
  charset: 'gb2312-1' | 'gb2312-2' | 'latin' | 'custom'
  chars?: string
  size_px: number
  simplify_tol: number
  face_index: number
}

/** Upload a font file. .gfont/.psf → 201 FontSummary; .ttf/.otf/.ttc → 202 TaskRef. */
export async function uploadFont(file: File, ttf?: TtfConvertOptions): Promise<FontSummary | TaskRef> {
  const fd = new FormData()
  fd.append('file', file, file.name)
  if (ttf) {
    for (const [k, v] of Object.entries(ttf)) if (v != null && v !== '') fd.append(k, String(v))
  }
  const r = await api.post<FontSummary | TaskRef>('/fonts', fd, { timeoutMs: 180_000 })
  void invalidateFonts()
  return r
}

export function reindexFonts() {
  return api.post<TaskRef>('/fonts/reindex', {})
}

export function invalidateFontList() {
  return invalidateFonts()
}

export const FONT_SOURCE_LABEL: Record<string, string> = {
  bundled: '内置',
  upload: '已上传',
  ttf: 'TTF 转换',
  builtin: '内置',
}
