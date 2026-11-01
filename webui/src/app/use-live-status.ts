import { useShallow } from 'zustand/react/shallow'
import { statusView } from '@/api/status-view'
import { useLive } from '@/api/store'

/** Current machine-status presentation (memo-friendly). */
export function useLiveStatus() {
  const s = useLive(
    useShallow((s) => ({
      conn: s.conn,
      everConnected: s.everConnected,
      machine: s.machine,
      job: s.job,
      progress: s.progress,
      firmwareErrors: s.firmwareErrors,
    })),
  )
  return { ...s, view: statusView(s) }
}
