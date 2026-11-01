/**
 * Reference backgrounds (Page.background, 04-contract-notes §8.1): scanned note templates / sheets shown under the
 * design. Never printed. Import an image (EXIF rotation baked in server-side) or a PDF page (rasterised server-side).
 */
import { api } from './client'
import type { components } from './schema'

type S = components['schemas']
export type PageBackground = S['PageBackground']
export type BackgroundTransform = S['BackgroundTransform']
export type BackgroundImportResult = S['BackgroundImportResult']

export const BACKGROUND_ACCEPT = '.pdf,.png,.jpg,.jpeg,.webp'

export function isBackgroundFile(name: string) {
  return /\.(pdf|png|jpe?g|webp)$/i.test(name)
}

/** Upload an image or PDF (page `page`, 0-based) as a background raster. */
export function importBackground(file: File, opts: { page?: number; dpi?: number } = {}) {
  const fd = new FormData()
  fd.append('file', file, file.name)
  fd.append('page', String(opts.page ?? 0))
  fd.append('dpi', String(opts.dpi ?? 150))
  return api.post<BackgroundImportResult>('/import/background', fd, { timeoutMs: 180_000 })
}

/** Rasterise another page of an uploaded background PDF. */
export function backgroundPage(sourceId: string, page: number, dpi = 150) {
  return api.post<BackgroundImportResult>(`/import/background/${sourceId}/page`, { page, dpi }, { timeoutMs: 120_000 })
}

/** Same-origin URLs (cookie auth works for <img>/<image>). */
export const fileContentUrl = (fileId: string) => `/api/v1/files/${encodeURIComponent(fileId)}/content`
export const pdfThumbUrl = (sourceId: string, page: number, size = 240) =>
  `/api/v1/import/background/${encodeURIComponent(sourceId)}/pages/${page}/thumb.png?size=${size}`
