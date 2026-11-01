/**
 * Global drag-and-drop import registry (02-ux §2.7).
 *
 * Features register handlers (ideally from a tiny, eagerly imported module — see src/app/import-handlers.ts):
 *
 *   registerImportHandler({
 *     id: 'fonts.install', label: '安装到字库', icon: Type,
 *     accept: ['.psf', '.gfont', '.ttf', '.otf', '.ttc'],
 *     run: async (files, ctx) => { ctx.navigate('/fonts'); … },
 *   })
 *
 * When files are dropped anywhere, the overlay shows up to 3 handlers that accept **all** dropped files
 * (sorted by `priority`, highest first; the first is highlighted/default). Extensions are matched by
 * `fileExt()` (so `.penplot.json` is distinct from `.json`).
 */
import type { LucideIcon } from 'lucide-react'
import { useSyncExternalStore } from 'react'
import type { NavigateFunction } from 'react-router-dom'
import { fileExt } from './format'

export interface ImportContext {
  navigate: NavigateFunction
  /** Current router pathname at drop time (e.g. to know whether Studio is open). */
  pathname: string
}

export interface ImportHandler {
  id: string
  label: string
  description?: string
  icon?: LucideIcon
  /** Lower-case extensions incl. dot. */
  accept: string[]
  /** Higher first. Default 0. */
  priority?: number
  /** Optional finer filter (e.g. only when on /studio). Evaluated while dragging, before files are readable. */
  when?: (ctx: ImportContext) => boolean
  run: (files: File[], ctx: ImportContext) => void | Promise<void>
}

/** Every extension the product knows about (02-ux §2.7). Unknown ones show "不支持 .xxx". */
export const KNOWN_IMPORT_EXTS = [
  '.svg', '.dxf', '.png', '.jpg', '.jpeg', '.webp', '.gcode', '.nc', '.gco', '.txt', '.csv', '.xlsx',
  '.psf', '.gfont', '.ttf', '.otf', '.ttc', '.penplot.json', '.json', '.zip',
]

/** Best-effort extension from a drag item's MIME type (file names are unreadable until drop). */
export function extFromMime(mime: string): string | null {
  const m: Record<string, string> = {
    'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/svg+xml': '.svg',
    'text/csv': '.csv', 'text/plain': '.txt', 'font/ttf': '.ttf', 'font/otf': '.otf', 'font/collection': '.ttc',
    'application/x-font-ttf': '.ttf', 'application/x-font-otf': '.otf', 'image/vnd.dxf': '.dxf', 'application/dxf': '.dxf',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx', 'application/zip': '.zip',
  }
  return m[mime] ?? null
}

const handlers = new Map<string, ImportHandler>()
const listeners = new Set<() => void>()
let version = 0

export function registerImportHandler(h: ImportHandler): () => void {
  handlers.set(h.id, h)
  version++
  listeners.forEach((l) => l())
  return () => {
    if (handlers.get(h.id) === h) {
      handlers.delete(h.id)
      version++
      listeners.forEach((l) => l())
    }
  }
}

export function handlersFor(files: File[], ctx: ImportContext): ImportHandler[] {
  return handlersForExts(files.map((f) => fileExt(f.name)), ctx)
}

/** Handlers accepting every one of `exts` (lower-case, with dot). */
export function handlersForExts(exts: string[], ctx: ImportContext): ImportHandler[] {
  if (!exts.length) return []
  return [...handlers.values()]
    .filter((h) => exts.every((e) => h.accept.includes(e)))
    .filter((h) => (h.when ? h.when(ctx) : true))
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
    .slice(0, 3)
}

export function useImportRegistryVersion() {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => version,
  )
}
