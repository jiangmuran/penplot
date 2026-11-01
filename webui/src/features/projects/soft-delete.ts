/**
 * Soft delete with undo (05-review §3.3): the item disappears at once, a toast offers 撤销 for 10 s,
 * and the DELETE is only sent when the window passes. Survives navigating away (module-level timers);
 * pending deletes are flushed if the tab is closed.
 */
import { create } from 'zustand'
import { deleteProject, invalidateProjects, type ProjectSummary } from '@/api/projects'
import { toast } from '@/lib/toast'
import { errParts } from './ext'

const UNDO_MS = 10_000

interface S {
  hidden: Record<string, true>
}
export const useSoftDeleted = create<S>(() => ({ hidden: {} }))
const timers = new Map<string, ReturnType<typeof setTimeout>>()

function unhide(id: string) {
  const { [id]: _, ...rest } = useSoftDeleted.getState().hidden
  useSoftDeleted.setState({ hidden: rest })
}

async function commit(p: ProjectSummary) {
  timers.delete(p.id)
  try {
    await deleteProject(p.id)
  } catch (e) {
    unhide(p.id)
    const m = errParts(e, `没能删除“${p.name}”`)
    toast.error(m.title, { description: m.description })
  } finally {
    void invalidateProjects().then(() => unhide(p.id))
  }
}

export function softDeleteProject(p: ProjectSummary) {
  useSoftDeleted.setState((s) => ({ hidden: { ...s.hidden, [p.id]: true } }))
  timers.set(p.id, setTimeout(() => void commit(p), UNDO_MS))
  toast({
    title: `已删除${p.is_template ? '模板' : '项目'}“${p.name}”`,
    level: 'info',
    duration: UNDO_MS,
    action: {
      label: '撤销',
      onClick: () => {
        const t = timers.get(p.id)
        if (t) clearTimeout(t)
        timers.delete(p.id)
        unhide(p.id)
      },
    },
  })
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => {
    for (const [id, t] of timers) {
      clearTimeout(t)
      // keepalive so the request survives unload
      void fetch(`/api/v1/projects/${id}`, { method: 'DELETE', credentials: 'include', keepalive: true, headers: { 'X-Penplot': '1' } })
    }
    timers.clear()
  })
}
