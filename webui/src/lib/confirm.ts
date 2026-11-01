/**
 * Imperative confirmation dialog (Alert Dialog, 02-ux §2.6), rendered by <ConfirmHost/> in the shell.
 *
 *   if (await confirm({ title: '删除字体“行书”？', description: '此操作无法撤销。',
 *                       confirmLabel: '删除', destructive: true })) { … }
 *
 * The cancel button has default focus. Destructive confirm buttons use red text.
 */
import { create } from 'zustand'

export interface ConfirmOptions {
  title: string
  description?: string
  confirmLabel?: string
  cancelLabel?: string
  destructive?: boolean
  /** Bullet list under the description (e.g. safety issues). */
  items?: string[]
  /** Information only: a single 知道了 button (resolves false). */
  alertOnly?: boolean
}

interface ConfirmState {
  current: (ConfirmOptions & { resolve: (ok: boolean) => void }) | null
  open: (o: ConfirmOptions) => Promise<boolean>
  close: (ok: boolean) => void
}

export const useConfirmStore = create<ConfirmState>((set, get) => ({
  current: null,
  open: (o) =>
    new Promise<boolean>((resolve) => {
      get().current?.resolve(false)
      set({ current: { ...o, resolve } })
    }),
  close: (ok) => {
    get().current?.resolve(ok)
    set({ current: null })
  },
}))

export const confirm = (o: ConfirmOptions) => useConfirmStore.getState().open(o)
