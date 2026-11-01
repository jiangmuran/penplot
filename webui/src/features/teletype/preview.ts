import { keepPreviousData, useQuery } from '@tanstack/react-query'
import * as React from 'react'
import { teletypeApi, type SessionForm } from '@/api/teletype'

/** Debounced value (settings typed into number fields). */
function useDebounced<T>(v: T, ms: number) {
  const [d, setD] = React.useState(v)
  React.useEffect(() => {
    const t = setTimeout(() => setD(v), ms)
    return () => clearTimeout(t)
  }, [v, ms])
  return d
}

/**
 * Server-side layout of a sample line with the given settings (POST /teletype/preview): the grid (columns depend
 * on the font), cell widths and the real glyph strokes. Identical requests are shared through the query cache.
 */
export function useTeletypePreview(f: Pick<SessionForm, 'font_id' | 'char_h' | 'letter_spacing' | 'line_spacing' | 'paper_w' | 'paper_h' | 'margin'>, enabled = true, text?: string) {
  const body = useDebounced(
    {
      font_id: f.font_id, char_h: f.char_h, letter_spacing: f.letter_spacing, line_spacing: f.line_spacing,
      paper_w: f.paper_w, paper_h: f.paper_h, margin: f.margin, ...(text ? { text } : {}),
    },
    250,
  )
  return useQuery({
    queryKey: ['teletype', 'preview', body],
    queryFn: ({ signal }) => teletypeApi.preview(body, signal),
    enabled,
    placeholderData: keepPreviousData,
    staleTime: 5 * 60_000,
    retry: false,
  })
}
