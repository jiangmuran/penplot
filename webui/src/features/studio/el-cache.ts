/**
 * Persistent cache of element-local renders (IndexedDB, keyed by elementKey). A reload shows the previous paths
 * at once while the server re-renders. Best effort: any IndexedDB failure just means no cache.
 */
import type { ElRender } from './render-engine'

const DB = 'penplot-studio'
const STORE = 'el-render'
const MAX_D = 1_500_000 // skip huge traced images
let dbp: Promise<IDBDatabase | null> | null = null

function db(): Promise<IDBDatabase | null> {
  if (dbp) return dbp
  dbp = new Promise((resolve) => {
    try {
      const r = indexedDB.open(DB, 1)
      r.onupgradeneeded = () => r.result.createObjectStore(STORE)
      r.onsuccess = () => resolve(r.result)
      r.onerror = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
  return dbp
}

export type CachedRender = Pick<ElRender, 'd' | 'bbox' | 'pages' | 'strokes' | 'missing' | 'overflow'>

export async function cacheGetMany(keys: string[]): Promise<Record<string, CachedRender>> {
  const d = await db()
  if (!d || !keys.length) return {}
  return new Promise((resolve) => {
    const out: Record<string, CachedRender> = {}
    try {
      const tx = d.transaction(STORE, 'readonly')
      const st = tx.objectStore(STORE)
      for (const k of keys) {
        const r = st.get(k)
        r.onsuccess = () => {
          if (r.result) out[k] = r.result as CachedRender
        }
      }
      tx.oncomplete = () => resolve(out)
      tx.onerror = () => resolve(out)
    } catch {
      resolve(out)
    }
  })
}

let writes = 0
export async function cachePutMany(entries: Record<string, ElRender>) {
  const d = await db()
  if (!d) return
  try {
    const tx = d.transaction(STORE, 'readwrite')
    const st = tx.objectStore(STORE)
    for (const [k, v] of Object.entries(entries)) {
      if (v.status !== 'ok') continue
      const size = (v.d?.length ?? 0) + (v.pages?.reduce((n, p) => n + p.d.length, 0) ?? 0)
      if (size > MAX_D) continue
      st.put({ d: v.d, bbox: v.bbox, pages: v.pages, strokes: v.strokes, missing: v.missing, overflow: v.overflow } satisfies CachedRender, k)
    }
    // keep the store bounded: every 50 writes drop everything beyond the newest ~600 keys (insertion order unknown → clear when large)
    if (++writes % 50 === 0) {
      const c = st.count()
      c.onsuccess = () => {
        if (c.result > 1500) st.clear()
      }
    }
  } catch {
    /* quota / private mode */
  }
}
