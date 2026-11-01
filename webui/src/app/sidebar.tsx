import { ArrowUpRight, PenTool } from 'lucide-react'
import { NavLink, useLocation } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/api/client'
import { qk } from '@/api/query'
import type { Job } from '@/api/types'
import { Tooltip } from '@/components/ui'
import { cn } from '@/lib/cn'
import { NAV_GROUPS, isActive, type NavItem } from './nav'
import { SidebarMiniPlayer } from './mini-player'
import { UserMenu } from './user-menu'

/** Number of queued jobs (sidebar badge). Silent on errors. */
function useQueuedCount() {
  const q = useQuery({
    queryKey: qk.jobs.list({ status: 'queued' }),
    queryFn: () => api.get<Job[]>('/jobs', { query: { status: 'queued', limit: 100 } }),
    staleTime: 15_000,
    retry: false,
  })
  return Array.isArray(q.data) ? q.data.length : 0
}

/** Translucent source-list sidebar (02-ux §2.1). */
export function Sidebar({ onNavigate, className }: { onNavigate?: () => void; className?: string }) {
  const { pathname } = useLocation()
  const queued = useQueuedCount()
  return (
    <nav aria-label="主导航" className={cn('mat-sidebar hairline-r flex h-full w-[var(--sidebar-w)] flex-col', className)}>
      <div className="flex h-[var(--toolbar-h)] shrink-0 items-center gap-2 px-4">
        <span className="flex size-7 items-center justify-center rounded-[7px] bg-gradient-to-b from-accent to-accent/80 text-white shadow-sm">
          <PenTool className="size-4" strokeWidth={2.25} />
        </span>
        <span className="text-headline text-label">PenPlot</span>
      </div>
      <div className="scrollbar-none min-h-0 flex-1 overflow-y-auto px-2.5 pb-2">
        {NAV_GROUPS.map((g) => (
          <div key={g.id} className="mb-3">
            <div className="px-2 pb-1 pt-2 text-caption font-semibold text-secondary-label">{g.label}</div>
            <ul className="flex flex-col gap-px">
              {g.items.map((item) => (
                <li key={item.id}>
                  <SidebarItem item={item} active={isActive(item, pathname)} badge={item.id === 'jobs' && queued ? queued : undefined} onNavigate={onNavigate} />
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <SidebarMiniPlayer />
      <div className="hairline-t shrink-0 px-2 py-1.5 pb-safe">
        <UserMenu />
      </div>
    </nav>
  )
}

function SidebarItem({ item, active, badge, onNavigate }: { item: NavItem; active: boolean; badge?: number; onNavigate?: () => void }) {
  const Icon = item.icon
  const cls = cn(
    'focus-ring group flex h-8 items-center gap-2 rounded-sm px-2 text-body text-label transition-colors duration-[var(--dur-instant)] pointer-coarse:h-11 pointer-coarse:gap-3',
    active ? 'bg-accent/15 font-medium' : 'hover:bg-quaternary-fill',
  )
  const inner = (
    <>
      <Icon className={cn('size-[18px] shrink-0 pointer-coarse:size-[22px]', active ? 'text-accent' : 'text-secondary-label')} strokeWidth={2} aria-hidden />
      <span className="min-w-0 flex-1 truncate">{item.label}</span>
      {badge ? <span className="rounded-full bg-fill px-1.5 text-caption font-medium text-secondary-label tabular-nums">{badge}</span> : null}
      {item.external ? <ArrowUpRight className="size-3.5 text-tertiary-label" aria-label="在新标签页打开" /> : null}
    </>
  )
  if (item.external) {
    return (
      <a href={item.to} target="_blank" rel="noreferrer" className={cls}>
        {inner}
      </a>
    )
  }
  return (
    <Tooltip content={item.label} shortcut={item.shortcut} side="right">
      <NavLink to={item.to} className={cls} aria-current={active ? 'page' : undefined} onClick={onNavigate}>
        {inner}
      </NavLink>
    </Tooltip>
  )
}
