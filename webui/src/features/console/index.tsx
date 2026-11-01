import { useSearchParams } from 'react-router-dom'
import { Page } from '@/app/page'
import { Segmented } from '@/components/ui'
import { CodesTab } from './codes-tab'
import { ConsoleTab } from './console-tab'
import { GrblTab } from './grbl-tab'

type Tab = 'console' | 'grbl' | 'codes'
const TABS: { value: Tab; label: string }[] = [
  { value: 'console', label: '控制台' },
  { value: 'grbl', label: 'GRBL 参数' },
  { value: 'codes', label: '代码参考' },
]

export default function ConsolePage() {
  const [params, setParams] = useSearchParams()
  const raw = params.get('tab')
  const tab: Tab = raw === 'grbl' || raw === 'codes' ? raw : 'console'
  const setTab = (t: Tab) => {
    const next = new URLSearchParams(params)
    if (t !== 'codes') next.delete('code')
    if (t === 'console') next.delete('tab')
    else next.set('tab', t)
    setParams(next, { replace: true })
  }
  return (
    <Page
      title="调试"
      largeTitle={tab !== 'console'}
      maxWidth={tab === 'console' ? undefined : 1200}
      toolbar={<Segmented aria-label="调试分区" value={tab} onValueChange={setTab} options={TABS} />}
    >
      <div role="tabpanel" aria-label={TABS.find((t) => t.value === tab)?.label} className="flex min-h-0 flex-1 flex-col">
        {tab === 'console' ? <ConsoleTab /> : tab === 'grbl' ? <GrblTab /> : <CodesTab />}
      </div>
    </Page>
  )
}
