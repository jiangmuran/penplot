import { ChevronsUpDown, Keyboard, LogOut, Monitor, Moon, Palette, Shield, Sun, UserRound } from 'lucide-react'
import * as React from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuthState, useLogout } from '@/api/auth'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem,
  DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger,
} from '@/components/ui'
import { getTheme, setTheme, type ThemePref } from '@/lib/theme'
import { useUi } from './ui-store'

export function useThemePref(): [ThemePref, (t: ThemePref) => void] {
  const [t, setT] = React.useState<ThemePref>(getTheme())
  return [t, (v) => (setTheme(v), setT(v))]
}

/** Sidebar-bottom account menu. */
export function UserMenu() {
  const { data } = useAuthState()
  const logout = useLogout()
  const navigate = useNavigate()
  const [theme, setThemePref] = useThemePref()
  const set = useUi((s) => s.set)
  const name = data?.user_info?.display_name || data?.user || '管理员'
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="focus-ring flex h-10 w-full items-center gap-2 rounded-md px-2 text-left hover:bg-quaternary-fill data-[state=open]:bg-tertiary-fill pointer-coarse:h-12"
        >
          <span className="flex size-6 items-center justify-center rounded-full bg-gradient-to-b from-gray2 to-gray text-white">
            <UserRound className="size-3.5" strokeWidth={2.5} />
          </span>
          <span className="min-w-0 flex-1 truncate text-body font-medium">{name}</span>
          <ChevronsUpDown className="size-3.5 text-tertiary-label" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="w-56">
        <DropdownMenuLabel>{data?.authenticated ? `已登录：${name}` : '未登录'}</DropdownMenuLabel>
        <DropdownMenuItem icon={<Shield />} onSelect={() => navigate('/settings/account')}>
          账户与安全
        </DropdownMenuItem>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger icon={<Palette />}>外观</DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuRadioGroup value={theme} onValueChange={(v) => setThemePref(v as ThemePref)}>
              <DropdownMenuRadioItem value="system">
                <Monitor className="!size-4" aria-hidden />
                <span>跟随系统</span>
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="light">
                <Sun className="!size-4" aria-hidden />
                <span>浅色</span>
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="dark">
                <Moon className="!size-4" aria-hidden />
                <span>深色</span>
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuItem icon={<Keyboard />} shortcut="?" onSelect={() => set({ shortcutsSheet: true })}>
          键盘快捷键
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          icon={<LogOut />}
          destructive
          onSelect={() => logout.mutate(undefined, { onSettled: () => navigate('/login', { replace: true }) })}
        >
          退出登录
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
