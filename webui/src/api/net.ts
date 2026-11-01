/**
 * REST link health. The board's WiFi drops for 10–20 s a few times an hour; every request then fails with
 * a network error or a proxy 502/503/504. Those are "连接中断", not per-request errors: the client records
 * them here, the shell shows the reconnecting banner, queries retry with backoff and keep their last data,
 * and when the link comes back all active queries refetch.
 */
import { create } from 'zustand'

interface NetState {
  /** ms timestamp of the first failed request of the current outage; null = link OK */
  downSince: number | null
  lastOkAt: number
}

export const useNet = create<NetState>(() => ({ downSince: null, lastOkAt: Date.now() }))

const upListeners = new Set<() => void>()
/** Called once when the link comes back after an outage. */
export function onLinkRestored(fn: () => void) {
  upListeners.add(fn)
  return () => {
    upListeners.delete(fn)
  }
}

export function reportLinkDown() {
  if (useNet.getState().downSince == null) useNet.setState({ downSince: Date.now() })
}

export function reportLinkOk() {
  const was = useNet.getState().downSince
  useNet.setState({ downSince: null, lastOkAt: Date.now() })
  if (was != null) for (const f of upListeners) f()
}
