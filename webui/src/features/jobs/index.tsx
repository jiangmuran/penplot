import * as React from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useJobs } from '@/api/jobs'
import { Page } from '@/app/page'
import { Segmented } from '@/components/ui'
import { useBreakpoint } from '@/lib/media'
import { CurrentJobCard } from './current-job'
import { HistorySection } from './history'
import { JobDetailSheet } from './job-detail'
import { QueueCard } from './queue-card'
import { RecoveryBanner } from './recovery-wizard'
import { useHideMiniPlayer } from '@/app/mini-player'
import { LeaseStrip } from '@/features/machine/lease'

type View = 'now' | 'queue' | 'history'

export default function JobsPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const bp = useBreakpoint()
  const compact = bp === 'compact'
  const [view, setView] = React.useState<View>('now')
  const queued = useJobs({ status: 'queued' })
  const qn = queued.data?.length ?? 0
  const all = useJobs()

  useHideMiniPlayer()
  const close = React.useCallback(() => navigate('/jobs', { replace: true }), [navigate])

  return (
    <Page title="任务">
      {compact ? (
        <div className="flex flex-col gap-4">
          <LeaseStrip />
          <RecoveryBanner jobs={all.data} />
          <Segmented<View>
            block
            aria-label="视图"
            value={view}
            onValueChange={setView}
            options={[
              { value: 'now', label: '进行中' },
              { value: 'queue', label: qn ? `队列 ${qn}` : '队列' },
              { value: 'history', label: '历史' },
            ]}
          />
          {view === 'now' ? <CurrentJobCard compact /> : null}
          {view === 'queue' ? <QueueCard /> : null}
          {view === 'history' ? <HistorySection compact /> : null}
        </div>
      ) : (
        <div className="flex flex-col gap-6">
          <div className="flex flex-col gap-3 empty:hidden">
            <LeaseStrip />
            <RecoveryBanner jobs={all.data} />
          </div>
          <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-3">
            <div className="lg:col-span-2">
              <CurrentJobCard />
            </div>
            <QueueCard />
          </div>
          <HistorySection />
        </div>
      )}
      <JobDetailSheet id={id} onClose={close} />
    </Page>
  )
}
