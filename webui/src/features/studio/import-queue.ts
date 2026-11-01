/**
 * Tiny hand-off between the global drop overlay and the studio page (kept dependency-free so the
 * import handler module stays light). Files dropped while the studio is closed wait here until it opens.
 */
export type QueuedImport = { files: File[]; as?: 'element' | 'letter' | 'background' }

const pending: QueuedImport[] = []
const listeners = new Set<() => void>()

export function enqueueImport(item: QueuedImport) {
  pending.push(item)
  listeners.forEach((l) => l())
}

export function takeImports(): QueuedImport[] {
  return pending.splice(0, pending.length)
}

export function onImport(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}
