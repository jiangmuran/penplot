/**
 * Font favourites and recents (05-review §3.7), kept in localStorage. Light module: studio may import
 * `markFontUsed(id)` when a font is applied to an element, and `useFontPrefs` to build its picker sections.
 */
import { create } from 'zustand'

const FAV_KEY = 'penplot.fonts.favorites'
const RECENT_KEY = 'penplot.fonts.recent'
export const RECENT_MAX = 5

function load(key: string): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? '[]') as unknown
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}
function save(key: string, v: string[]) {
  try {
    localStorage.setItem(key, JSON.stringify(v))
  } catch {
    /* private mode / quota */
  }
}

interface FontPrefs {
  favorites: string[]
  recent: string[]
  toggleFavorite: (id: string) => boolean
  markUsed: (id: string) => void
}

export const useFontPrefs = create<FontPrefs>((set, get) => ({
  favorites: load(FAV_KEY),
  recent: load(RECENT_KEY),
  toggleFavorite: (id) => {
    const cur = get().favorites
    const on = !cur.includes(id)
    const next = on ? [id, ...cur] : cur.filter((x) => x !== id)
    save(FAV_KEY, next)
    set({ favorites: next })
    return on
  },
  markUsed: (id) => {
    const next = [id, ...get().recent.filter((x) => x !== id)].slice(0, RECENT_MAX)
    save(RECENT_KEY, next)
    set({ recent: next })
  },
}))

export const markFontUsed = (id: string) => useFontPrefs.getState().markUsed(id)

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === FAV_KEY) useFontPrefs.setState({ favorites: load(FAV_KEY) })
    if (e.key === RECENT_KEY) useFontPrefs.setState({ recent: load(RECENT_KEY) })
  })
}

let common: string[] | null = null
/**
 * 常用字 = GB2312 level-1 hanzi (3,755, the national "常用字" list), decoded with the browser's GBK
 * TextDecoder so the list isn't shipped in the bundle.
 */
export function commonChars(): string[] {
  if (common) return common
  const bytes: number[] = []
  for (let r = 0xb0; r <= 0xd7; r++) {
    for (let c = 0xa1; c <= 0xfe; c++) {
      if (r === 0xd7 && c > 0xf9) break
      bytes.push(r, c)
    }
  }
  try {
    common = [...new TextDecoder('gbk').decode(new Uint8Array(bytes))]
  } catch {
    common = []
  }
  return common
}

/** Split a char list into URL-safe chunks (the dev proxy rejects request lines over ~16 KB). */
export function chunkChars(chars: string[], size = 900): string[] {
  const out: string[] = []
  for (let i = 0; i < chars.length; i += size) out.push(chars.slice(i, i + size).join(''))
  return out
}

/** Fonts with fewer glyphs than this are flagged 「不完整」 and sorted last. */
export const INCOMPLETE_GLYPHS = 500
