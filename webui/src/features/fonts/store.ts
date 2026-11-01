/**
 * Tiny module-level state for the fonts feature (kept light: imported eagerly by the drop handler).
 * - TTF conversion sheet: open state + prefilled file
 * - background tasks started from this page (TTF conversion, reindex) shown as progress rows
 */
import { create } from 'zustand'

export interface FontTaskEntry {
  id: string
  label: string
  kind: 'ttf' | 'reindex'
}

interface FontsUiState {
  ttfOpen: boolean
  ttfFile: File | null
  tasks: FontTaskEntry[]
  openTtf: (file?: File | null) => void
  closeTtf: () => void
  addTask: (t: FontTaskEntry) => void
  removeTask: (id: string) => void
}

export const useFontsUi = create<FontsUiState>((set, get) => ({
  ttfOpen: false,
  ttfFile: null,
  tasks: [],
  openTtf: (file = null) => set({ ttfOpen: true, ttfFile: file }),
  closeTtf: () => set({ ttfOpen: false }),
  addTask: (t) => set({ tasks: [t, ...get().tasks.filter((x) => x.id !== t.id)] }),
  removeTask: (id) => set({ tasks: get().tasks.filter((x) => x.id !== id) }),
}))

export const TTF_EXTS = ['.ttf', '.otf', '.ttc', '.otc']
export const FONT_EXTS = ['.gfont', '.psf']
export const FONT_ACCEPT = [...FONT_EXTS, ...TTF_EXTS].join(',')
