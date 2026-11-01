import { Ellipsis } from 'lucide-react'
import { NavLink, useLocation } from 'react-router-dom'
import { cn } from '@/lib/cn'
import { MORE_ITEMS, TAB_ITEMS, isActive } from './nav'
import { useUi } from './ui-store'

/** Compact bottom tab bar: 创作 / 任务 / 控制 / 调试 / 更多 (02-ux §2.2). */
export function TabBar() {
  const { pathname } = useLocation()
  const set = useUi((s) => s.set)
  const moreActive = MORE_ITEMS.some((i) => isActive(i, pathname))
  const item = 'focus-ring flex flex-1 flex-col items-center justify-center gap-0.5 pt-1 text-[12px] font-medium leading-[14px]'
  return (
    <nav aria-label="主导航" className="mat-toolbar hairline-t pb-safe shrink-0">
      <ul className="flex h-[var(--tabbar-h)] items-stretch px-2">
        {TAB_ITEMS.map((t) => {
          const active = isActive(t, pathname)
          const Icon = t.icon
          return (
            <li key={t.id} className="flex flex-1">
              <NavLink to={t.to} aria-current={active ? 'page' : undefined} className={cn(item, active ? 'text-accent' : 'text-gray')}>
                <Icon className="size-[22px]" strokeWidth={active ? 2.25 : 1.75} aria-hidden />
                <span>{t.short ?? t.label}</span>
              </NavLink>
            </li>
          )
        })}
        <li className="flex flex-1">
          <button type="button" onClick={() => set({ moreSheet: true })} className={cn(item, moreActive ? 'text-accent' : 'text-gray')} aria-haspopup="dialog">
            <Ellipsis className="size-[22px]" strokeWidth={moreActive ? 2.25 : 1.75} aria-hidden />
            <span>更多</span>
          </button>
        </li>
      </ul>
    </nav>
  )
}
