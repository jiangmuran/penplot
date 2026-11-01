/**
 * Toast + notification-center store (02-ux §2.6).
 *
 *   import { toast } from '@/lib/toast'
 *   toast.success('已保存')
 *   toast.error('写入失败', { description: err.message })
 *   toast({ title: '已删除元素', action: { label: '撤销', onClick: undo }, duration: 5000 })
 *   toast.info('正在重连', { key: 'ws' })   // same key → merged ("×3"), timer re-armed
 *
 * Durations: info 4 s, success 3 s, warning 6 s, error sticky. Max 3 on screen; overflow queues.
 * Every toast is also kept in `history` (notification center, last 50).
 */
import { create } from 'zustand'
import { uid } from './id'

export type ToastLevel = 'info' | 'success' | 'warning' | 'error'

export interface ToastAction {
  label: string
  onClick: () => void
}

export interface ToastInput {
  title: string
  description?: string
  level?: ToastLevel
  /** Merge key: a toast with the same key replaces the visible one and increments its count. */
  key?: string
  /** ms; Infinity = sticky. Defaults per level. */
  duration?: number
  action?: ToastAction
  /** Do not record in the notification center. */
  ephemeral?: boolean
}

export interface ToastItem extends Required<Pick<ToastInput, 'title' | 'level'>> {
  id: string
  description?: string
  key?: string
  duration: number
  action?: ToastAction
  count: number
  rev: number
  createdAt: number
}

export interface NotificationItem {
  id: string
  title: string
  description?: string
  level: ToastLevel
  count: number
  createdAt: number
  read: boolean
}

const DEFAULT_DURATION: Record<ToastLevel, number> = {
  info: 4000,
  success: 3000,
  warning: 6000,
  error: Number.POSITIVE_INFINITY,
}
const MAX_VISIBLE = 3

interface ToastState {
  toasts: ToastItem[]
  queue: ToastItem[]
  history: NotificationItem[]
  push: (t: ToastInput) => string
  dismiss: (id: string) => void
  clearHistory: () => void
  markAllRead: () => void
}

export const useToastStore = create<ToastState>((set, get) => ({
  toasts: [],
  queue: [],
  history: [],
  push: (input) => {
    const level = input.level ?? 'info'
    const now = Date.now()
    const { toasts, queue, history } = get()
    const histEntry = (id: string, count: number): NotificationItem[] => {
      if (input.ephemeral) return history
      const existing = input.key ? history.find((h) => h.id === id) : undefined
      if (existing) {
        return history.map((h) => (h.id === id ? { ...h, count, createdAt: now, read: false, title: input.title, description: input.description } : h))
      }
      return [{ id, title: input.title, description: input.description, level, count, createdAt: now, read: false }, ...history].slice(0, 50)
    }
    if (input.key) {
      const match = toasts.find((t) => t.key === input.key) ?? queue.find((t) => t.key === input.key)
      if (match) {
        const updated: ToastItem = {
          ...match,
          title: input.title,
          description: input.description,
          level,
          action: input.action,
          duration: input.duration ?? DEFAULT_DURATION[level],
          count: match.count + 1,
          rev: match.rev + 1,
        }
        set({
          toasts: toasts.map((t) => (t.id === match.id ? updated : t)),
          queue: queue.map((t) => (t.id === match.id ? updated : t)),
          history: histEntry(match.id, updated.count),
        })
        return match.id
      }
    }
    const item: ToastItem = {
      id: uid('t'),
      title: input.title,
      description: input.description,
      level,
      key: input.key,
      duration: input.duration ?? DEFAULT_DURATION[level],
      action: input.action,
      count: 1,
      rev: 0,
      createdAt: now,
    }
    if (toasts.length < MAX_VISIBLE) set({ toasts: [...toasts, item], history: histEntry(item.id, 1) })
    else set({ queue: [...queue, item], history: histEntry(item.id, 1) })
    return item.id
  },
  dismiss: (id) => {
    const { toasts, queue } = get()
    const rest = toasts.filter((t) => t.id !== id)
    const q = queue.filter((t) => t.id !== id)
    while (rest.length < MAX_VISIBLE && q.length) rest.push(q.shift()!)
    set({ toasts: rest, queue: q })
  },
  clearHistory: () => set({ history: [] }),
  markAllRead: () => set({ history: get().history.map((h) => ({ ...h, read: true })) }),
}))

type Opts = Omit<ToastInput, 'title' | 'level'>

function toastFn(input: ToastInput | string) {
  return useToastStore.getState().push(typeof input === 'string' ? { title: input } : input)
}
export const toast = Object.assign(toastFn, {
  info: (title: string, o: Opts = {}) => toastFn({ ...o, title, level: 'info' }),
  success: (title: string, o: Opts = {}) => toastFn({ ...o, title, level: 'success' }),
  warning: (title: string, o: Opts = {}) => toastFn({ ...o, title, level: 'warning' }),
  error: (title: string, o: Opts = {}) => toastFn({ ...o, title, level: 'error' }),
  dismiss: (id: string) => useToastStore.getState().dismiss(id),
})
