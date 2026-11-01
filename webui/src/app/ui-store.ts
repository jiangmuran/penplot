/**
 * Shell UI state (panel visibility per breakpoint, transient sheets). Persisted to localStorage.
 *   const open = useUi((s) => s.sidebar[bp])
 */
import { create } from 'zustand'
import type { Breakpoint } from '@/lib/media'

type PerBp = Record<Breakpoint, boolean>
const KEY = 'penplot.ui'

interface Persisted {
  sidebar: PerBp
  inspector: PerBp
}

function load(): Persisted {
  const def: Persisted = {
    sidebar: { compact: false, medium: false, regular: false, wide: true },
    inspector: { compact: false, medium: false, regular: true, wide: true },
  }
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return def
    const p = JSON.parse(raw) as Partial<Persisted>
    return { sidebar: { ...def.sidebar, ...p.sidebar }, inspector: { ...def.inspector, ...p.inspector } }
  } catch {
    return def
  }
}

export interface UiState extends Persisted {
  /** Overlay sidebar (medium/regular) open state — not persisted. */
  overlaySidebar: boolean
  moreSheet: boolean
  shortcutsSheet: boolean
  sessionExpired: boolean
  /** >0 while some page asked to hide the global mini-player (useHideMiniPlayer). */
  miniPlayerHidden: number
  toggleSidebar: (bp: Breakpoint) => void
  setSidebar: (bp: Breakpoint, open: boolean) => void
  toggleInspector: (bp: Breakpoint) => void
  setInspector: (bp: Breakpoint, open: boolean) => void
  set: (p: Partial<Pick<UiState, 'overlaySidebar' | 'moreSheet' | 'shortcutsSheet' | 'sessionExpired' | 'miniPlayerHidden'>>) => void
}

function persist(s: Persisted) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ sidebar: s.sidebar, inspector: s.inspector }))
  } catch {
    /* quota / private mode */
  }
}

export const useUi = create<UiState>((set, get) => ({
  ...load(),
  overlaySidebar: false,
  moreSheet: false,
  shortcutsSheet: false,
  sessionExpired: false,
  miniPlayerHidden: 0,
  toggleSidebar: (bp) => {
    if (bp === 'medium' || bp === 'regular') return set({ overlaySidebar: !get().overlaySidebar })
    const sidebar = { ...get().sidebar, [bp]: !get().sidebar[bp] }
    set({ sidebar })
    persist({ ...get(), sidebar })
  },
  setSidebar: (bp, open) => {
    if (bp === 'medium' || bp === 'regular') return set({ overlaySidebar: open })
    const sidebar = { ...get().sidebar, [bp]: open }
    set({ sidebar })
    persist({ ...get(), sidebar })
  },
  toggleInspector: (bp) => {
    const inspector = { ...get().inspector, [bp]: !get().inspector[bp] }
    set({ inspector })
    persist({ ...get(), inspector })
  },
  setInspector: (bp, open) => {
    const inspector = { ...get().inspector, [bp]: open }
    set({ inspector })
    persist({ ...get(), inspector })
  },
  set: (p) => set(p),
}))
