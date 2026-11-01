/**
 * Undoable font deletion (05-review §3.3): the font disappears from the lists at once, a toast offers
 * 撤销 for 10 s, and only then is DELETE sent. Leaving the page does not cancel the pending delete.
 */
import { api, errorMessage, isApiError } from '@/api/client'
import type { FontSummary } from '@/api/fonts'
import { qk, queryClient } from '@/api/query'
import { toast } from '@/lib/toast'

const UNDO_MS = 10_000
const pending = new Map<string, ReturnType<typeof setTimeout>>()

function dropFromLists(id: string) {
  queryClient.setQueriesData<FontSummary[]>({ queryKey: [...qk.fonts.all, 'list'] }, (old) => old?.filter((f) => f.id !== id))
}

export function isDeletePending(id: string) {
  return pending.has(id)
}

export function softDeleteFont(font: FontSummary, onRemoved?: () => void) {
  if (pending.has(font.id)) return
  void queryClient.cancelQueries({ queryKey: qk.fonts.all })
  dropFromLists(font.id)
  onRemoved?.()
  const timer = setTimeout(async () => {
    pending.delete(font.id)
    try {
      await api.delete(`/fonts/${encodeURIComponent(font.id)}`)
    } catch (e) {
      const why =
        isApiError(e) && e.code === 'in_use'
          ? '有排队或进行中的任务在用这个字体。等任务结束后再删除。'
          : `${errorMessage(e)}。字体已保留，稍后可以再试。`
      toast.error(`没能删除「${font.display_name}」`, { description: why })
    } finally {
      void queryClient.invalidateQueries({ queryKey: qk.fonts.all })
    }
  }, UNDO_MS)
  pending.set(font.id, timer)
  toast({
    title: `已删除「${font.display_name}」`,
    description: '引用它的项目会改用默认字体。',
    level: 'success',
    duration: UNDO_MS,
    action: {
      label: '撤销',
      onClick: () => {
        const t = pending.get(font.id)
        if (t) clearTimeout(t)
        pending.delete(font.id)
        void queryClient.invalidateQueries({ queryKey: qk.fonts.all })
      },
    },
  })
}
