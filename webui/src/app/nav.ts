/** Navigation model (02-ux §1). Order = Mod+1…8. */
import { BookOpen, Cpu, LifeBuoy, Gamepad2, Keyboard, LayoutGrid, ListChecks, PenLine, Settings, Terminal, Type, type LucideIcon } from 'lucide-react'

export interface NavItem {
  id: string
  label: string
  /** Short label for the compact tab bar */
  short?: string
  icon: LucideIcon
  to: string
  /** Paths that mark this item active */
  match: string
  shortcut?: string
  external?: boolean
}

export interface NavGroup {
  id: string
  label: string
  items: NavItem[]
}

export const NAV_GROUPS: NavGroup[] = [
  {
    id: 'create',
    label: '创作',
    items: [
      { id: 'studio', label: '创作台', short: '创作', icon: PenLine, to: '/studio', match: '/studio', shortcut: 'mod+1' },
      { id: 'projects', label: '项目与模板', short: '项目', icon: LayoutGrid, to: '/projects', match: '/projects', shortcut: 'mod+2' },
      { id: 'fonts', label: '字库', icon: Type, to: '/fonts', match: '/fonts', shortcut: 'mod+3' },
      { id: 'teletype', label: '电传打字机', short: '电传', icon: Keyboard, to: '/teletype', match: '/teletype' },
    ],
  },
  {
    id: 'machine',
    label: '机器',
    items: [
      { id: 'machine', label: '控制', icon: Gamepad2, to: '/machine', match: '/machine', shortcut: 'mod+4' },
      { id: 'jobs', label: '任务', icon: ListChecks, to: '/jobs', match: '/jobs', shortcut: 'mod+5' },
      { id: 'console', label: '调试', icon: Terminal, to: '/console', match: '/console', shortcut: 'mod+6' },
    ],
  },
  {
    id: 'system',
    label: '系统',
    items: [
      { id: 'settings', label: '设置', icon: Settings, to: '/settings/general', match: '/settings', shortcut: 'mod+7' },
      { id: 'system', label: '系统', icon: Cpu, to: '/system', match: '/system', shortcut: 'mod+8' },
      { id: 'help', label: '帮助', icon: LifeBuoy, to: '/help', match: '/help' },
      { id: 'api', label: 'API 文档', icon: BookOpen, to: '/api/v1/docs', match: '/api/v1/docs', external: true },
    ],
  },
]

export const NAV_ITEMS = NAV_GROUPS.flatMap((g) => g.items)
export const navById = (id: string) => NAV_ITEMS.find((i) => i.id === id)!

/** Compact tab bar: 创作 / 项目 / 任务 / 控制 / 更多 (调试 is for advanced users → 更多; 05-review §2.1) */
export const TAB_ITEMS = ['studio', 'projects', 'jobs', 'machine'].map(navById)
/** Items inside the compact "更多" sheet */
export const MORE_ITEMS = ['fonts', 'teletype', 'console', 'settings', 'system', 'help', 'api'].map(navById)

export function isActive(item: NavItem, pathname: string) {
  return pathname === item.match || pathname.startsWith(item.match + '/')
}
