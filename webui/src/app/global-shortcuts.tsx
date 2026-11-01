import { useLocation, useNavigate } from 'react-router-dom'
import { estop } from '@/api/machine'
import { isJobActive, useLive } from '@/api/store'
import { useBreakpoint } from '@/lib/media'
import { useShortcut } from '@/lib/shortcuts'
import { confirmStopJob, togglePause } from './job-actions'
import { NAV_ITEMS } from './nav'
import { useUi } from './ui-store'

function anyLayerOpen() {
  return !!document.querySelector('[role="dialog"][data-state="open"], [role="alertdialog"], [role="menu"][data-state="open"], [data-radix-popper-content-wrapper]')
}

/** Global shortcuts from 02-ux §5.2 that the shell owns. */
export function GlobalShortcuts() {
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const bp = useBreakpoint()
  const ui = useUi()

  useShortcut('mod+.', () => void estop(), { id: 'global.estop', description: '急停（立即）', group: '全局', allowInEditable: true })
  useShortcut('mod+alt+s', () => ui.toggleSidebar(bp), { id: 'global.sidebar', description: '显示/隐藏侧边栏', group: '全局' })
  useShortcut('mod+alt+i', () => ui.toggleInspector(bp), { id: 'global.inspector', description: '显示/隐藏检查器', group: '全局' })
  useShortcut('?', () => ui.set({ shortcutsSheet: true }), { id: 'global.help', description: '快捷键一览', group: '全局' })
  useShortcut(
    'space',
    () => {
      const job = useLive.getState().job
      if (!job || !isJobActive(job)) return false
      void togglePause(job)
    },
    { id: 'global.pause', description: '暂停 / 继续任务', group: '全局', when: () => !pathname.startsWith('/studio') && !anyLayerOpen() },
  )
  useShortcut(
    'escape',
    () => {
      const job = useLive.getState().job
      if (!job || job.status !== 'running') return false
      void confirmStopJob(job)
    },
    { id: 'global.stop', hidden: true, when: () => !pathname.startsWith('/studio') && !anyLayerOpen() },
  )
  return (
    <>
      {NAV_ITEMS.filter((i) => i.shortcut).map((i) => (
        <NavShortcut key={i.id} keys={i.shortcut!} label={`前往${i.label}`} go={() => navigate(i.to)} />
      ))}
    </>
  )
}

function NavShortcut({ keys, label, go }: { keys: string; label: string; go: () => void }) {
  useShortcut(keys, go, { id: `nav.${keys}`, description: label, group: '导航' })
  return null
}
