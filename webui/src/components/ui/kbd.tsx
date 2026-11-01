import { cn } from '@/lib/cn'
import { formatKeys } from '@/lib/shortcuts'

/** Keyboard shortcut label. <Kbd keys="mod+shift+e" /> → ⌘⇧E. Or <Kbd>Esc</Kbd>. */
export function Kbd({ keys, children, className }: { keys?: string; children?: React.ReactNode; className?: string }) {
  const parts = keys ? formatKeys(keys) : null
  return (
    <kbd
      className={cn(
        'inline-flex h-[18px] min-w-[18px] items-center justify-center gap-0.5 rounded-xs border border-separator bg-quaternary-fill px-1',
        'font-sans text-caption font-medium leading-none text-secondary-label',
        className,
      )}
    >
      {parts ? parts.map((p, i) => <span key={i}>{p}</span>) : children}
    </kbd>
  )
}
