import { ArrowUpRight, Keyboard, LogOut } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { useLogout } from '@/api/auth'
import { useMediaQuery } from '@/lib/media'
import { GroupedList, ListRow, Sheet, SheetContent } from '@/components/ui'
import { MORE_ITEMS } from './nav'
import { useUi } from './ui-store'

const TILE: Record<string, string> = { projects: 'bg-indigo', fonts: 'bg-orange', teletype: 'bg-purple', console: 'bg-gray2', settings: 'bg-gray', system: 'bg-green', api: 'bg-teal' }

/** Compact "更多" sheet: 字库、电传、调试、设置、系统、API、退出. */
export function MoreSheet() {
  const open = useUi((s) => s.moreSheet)
  const set = useUi((s) => s.set)
  const navigate = useNavigate()
  const logout = useLogout()
  const close = () => set({ moreSheet: false })
  // Keyboard shortcuts only make sense with a hardware keyboard (≈ a fine pointer / hover device).
  const hasKeyboard = useMediaQuery('(hover: hover) and (pointer: fine)')
  return (
    <Sheet open={open} onOpenChange={(o) => set({ moreSheet: o })}>
      <SheetContent side="bottom" defaultDetent="large" title="更多" className="bg-bg-grouped">
        <div className="flex flex-col gap-6 px-4 pb-6 pt-2">
          <GroupedList>
            {MORE_ITEMS.map((i) =>
              i.external ? (
                <ListRow
                  key={i.id}
                  icon={i.icon}
                  iconColor={TILE[i.id]}
                  label={i.label}
                  accessory={<ArrowUpRight className="size-4 text-tertiary-label" />}
                  chevron={false}
                  onClick={() => {
                    window.open(i.to, '_blank', 'noopener')
                    close()
                  }}
                />
              ) : (
                <ListRow
                  key={i.id}
                  icon={i.icon}
                  iconColor={TILE[i.id]}
                  label={i.label}
                  onClick={() => {
                    navigate(i.to)
                    close()
                  }}
                />
              ),
            )}
          </GroupedList>
          <GroupedList>
            {hasKeyboard ? <ListRow icon={Keyboard} iconColor="bg-gray" label="键盘快捷键" onClick={() => set({ moreSheet: false, shortcutsSheet: true })} /> : null}
            <ListRow
              icon={LogOut}
              iconColor="bg-red"
              label="退出登录"
              destructive
              onClick={() => logout.mutate(undefined, { onSettled: () => (close(), navigate('/login', { replace: true })) })}
            />
          </GroupedList>
        </div>
      </SheetContent>
    </Sheet>
  )
}
