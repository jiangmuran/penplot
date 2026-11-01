/**
 * 设置 /settings/:section (02-ux §3.10). Regular: 220px category list + inset-grouped form (max 640).
 * Compact: iOS-style push — /settings/general shows the category list, each section has a back button.
 */
import { ChevronLeft, FileText, Palette, ShieldCheck, SlidersHorizontal, Users, Wrench, type LucideIcon } from 'lucide-react'
import * as React from 'react'
import { Link, Navigate, useParams } from 'react-router-dom'
import { Page } from '@/app/page'
import { GroupedList, ListRow } from '@/components/ui'
import { cn } from '@/lib/cn'
import { useIsCompact } from '@/lib/media'
import { AccountSection } from './account'
import { AppearanceSection } from './appearance'
import { MachineSection } from './machine'
import { PapersSection } from './papers'
import { PreferencesSection } from './preferences'
import { UsersSection } from './users'
import { useRole } from '@/api/collab'

type SectionId = 'appearance' | 'machine' | 'papers' | 'account' | 'users' | 'preferences'

interface SectionDef {
  id: SectionId
  label: string
  description: string
  icon: LucideIcon
  tile: string
  adminOnly?: boolean
}

const SECTIONS: SectionDef[] = [
  { id: 'appearance', label: '外观', description: '浅色 / 深色、强调色、密度', icon: Palette, tile: 'bg-blue' },
  { id: 'machine', label: '机器配置', description: '控制器、串口、笔、行程', icon: Wrench, tile: 'bg-orange' },
  { id: 'papers', label: '纸张预设', description: '尺寸、边距与行格', icon: FileText, tile: 'bg-green' },
  { id: 'account', label: '账户与安全', description: '我的资料、密码、会话、API 令牌', icon: ShieldCheck, tile: 'bg-indigo' },
  { id: 'users', label: '用户与权限', description: '添加成员、分配角色', icon: Users, tile: 'bg-teal', adminOnly: true },
  { id: 'preferences', label: '偏好', description: '默认值、任务与服务', icon: SlidersHorizontal, tile: 'bg-gray' },
]

/** URL ↔ section. `general` is the shell's default: 外观 on regular, the category list on compact. */
function resolve(param: string | undefined, compact: boolean): SectionId | 'index' | null {
  if (!param || param === 'general') return compact ? 'index' : 'appearance'
  if (param === 'index') return compact ? 'index' : 'appearance'
  return SECTIONS.some((s) => s.id === param) ? (param as SectionId) : null
}
const hrefFor = (id: SectionId) => `/settings/${id}`

function SectionBody({ id, setActions }: { id: SectionId; setActions: (n: React.ReactNode) => void }) {
  switch (id) {
    case 'appearance':
      return <AppearanceSection />
    case 'machine':
      return <MachineSection onActions={setActions} />
    case 'papers':
      return <PapersSection onActions={setActions} />
    case 'account':
      return <AccountSection />
    case 'users':
      return <UsersSection onActions={setActions} />
    case 'preferences':
      return <PreferencesSection />
  }
}

function CategoryNav({ current, sections }: { current: SectionId; sections: SectionDef[] }) {
  return (
    <nav aria-label="设置分类" className="sticky top-0 flex w-[220px] shrink-0 flex-col gap-0.5 self-start">
      {sections.map((s) => {
        const on = s.id === current
        const Icon = s.icon
        return (
          <Link
            key={s.id}
            to={hrefFor(s.id)}
            replace
            aria-current={on ? 'page' : undefined}
            className={cn(
              'focus-ring flex h-9 items-center gap-2.5 rounded-md px-2 text-body transition-colors pointer-coarse:h-11',
              on ? 'bg-accent/15 font-medium text-label' : 'text-label hover:bg-quaternary-fill',
            )}
          >
            <span className={cn('flex size-[22px] shrink-0 items-center justify-center rounded-[6px] text-white shadow-sm', s.tile)}>
              <Icon className="size-3.5" strokeWidth={2.25} />
            </span>
            <span className="truncate">{s.label}</span>
          </Link>
        )
      })}
    </nav>
  )
}

export default function SettingsPage() {
  const { section } = useParams()
  const compact = useIsCompact()
  const current = resolve(section, compact)
  const [actions, setActions] = React.useState<React.ReactNode>(null)
  const role = useRole()
  const visible = SECTIONS.filter((s) => !s.adminOnly || role === 'admin')

  if (current == null) return <Navigate to="/settings/general" replace />

  if (current === 'index') {
    return (
      <Page title="设置">
        <GroupedList>
          {visible.map((s) => (
            <ListRow key={s.id} icon={s.icon} iconColor={s.tile} label={s.label} subtitle={s.description} to={hrefFor(s.id)} />
          ))}
        </GroupedList>
      </Page>
    )
  }

  const def = SECTIONS.find((s) => s.id === current)!

  if (compact) {
    return (
      <Page title={def.label} actions={actions} largeTitle={false}>
        <div className="mat-toolbar sticky top-0 z-10 -mx-4 -mt-4 mb-3 flex h-11 items-center px-1.5 hairline-b">
          <Link to="/settings/general" className="focus-ring press inline-flex h-11 items-center gap-0.5 rounded-md pr-3 text-body text-accent" aria-label="返回设置">
            <ChevronLeft className="size-7" strokeWidth={2.25} aria-hidden />
            设置
          </Link>
        </div>
        <SectionBody id={current} setActions={setActions} />
      </Page>
    )
  }

  return (
    <Page title="设置" subtitle={def.label} actions={actions}>
      <div className="mx-auto flex w-full max-w-[884px] gap-6">
        <CategoryNav current={current} sections={visible} />
        <div className="min-w-0 flex-1">
          <div className="w-full max-w-[640px]">
            <h2 className="mb-4 px-1 text-title2 text-label">{def.label}</h2>
            <SectionBody key={current} id={current} setActions={setActions} />
          </div>
        </div>
      </div>
    </Page>
  )
}
