import { Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle, Kbd } from '@/components/ui'
import { useShortcutList } from '@/lib/shortcuts'
import { useUi } from './ui-store'

/** "?" cheat-sheet listing every registered shortcut with a description. */
export function ShortcutsSheet() {
  const open = useUi((s) => s.shortcutsSheet)
  const set = useUi((s) => s.set)
  const list = useShortcutList()
  const groups = new Map<string, typeof list>()
  for (const s of list) {
    const g = s.group ?? '全局'
    groups.set(g, [...(groups.get(g) ?? []), s])
  }
  return (
    <Dialog open={open} onOpenChange={(o) => set({ shortcutsSheet: o })}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>键盘快捷键</DialogTitle>
          <DialogDescription>单键快捷键在输入框内不生效，可在 设置 › 通用 中关闭。</DialogDescription>
        </DialogHeader>
        <DialogBody className="pb-5">
          {[...groups].map(([g, items]) => (
            <section key={g} className="mb-4">
              <h3 className="mb-1 text-footnote font-semibold text-secondary-label">{g}</h3>
              <ul className="overflow-hidden rounded-lg bg-quaternary-fill">
                {items.map((s) => (
                  <li key={s.id} className="flex h-8 items-center justify-between px-3 text-body [&+&]:hairline-t">
                    <span>{s.description}</span>
                    <Kbd keys={s.keys} />
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}
