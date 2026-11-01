import * as React from 'react'
import { errorMessage } from '@/api/client'
import { jog, jogCancel } from '@/api/machine-control'
import { toast } from '@/lib/toast'

export interface JogVec {
  x: number
  y: number
  z: number
}

const TICK_MS = 120

/**
 * Jogging with a deadman: a tap sends one step; a hold streams small increments (sized so the planner
 * stays only slightly ahead) and sends a jog-cancel (0x85) the moment the hold ends — pointer up, key up,
 * window blur, tab hidden or unmount. At most one increment is in flight, so a WiFi stall stops the
 * stream instead of queueing motion.
 */
export function useJogger(opts: { feed: number; zFeed: number; enabled: boolean }) {
  const optsRef = React.useRef(opts)
  optsRef.current = opts
  const hold = React.useRef<{ vec: JogVec; timer: ReturnType<typeof setInterval>; inflight: boolean } | null>(null)
  const [holding, setHolding] = React.useState<JogVec | null>(null)

  const report = React.useCallback((e: unknown) => {
    toast.error('点动失败', { description: errorMessage(e), key: 'jog-error' })
  }, [])

  const step = React.useCallback(
    async (vec: JogVec, size: number) => {
      const o = optsRef.current
      if (!o.enabled) return
      const feed = vec.z && !vec.x && !vec.y ? o.zFeed : o.feed
      try {
        await jog({ dx: vec.x * size, dy: vec.y * size, dz: vec.z * size }, feed)
      } catch (e) {
        report(e)
      }
    },
    [report],
  )

  const stopHold = React.useCallback(() => {
    const h = hold.current
    if (!h) return
    clearInterval(h.timer)
    hold.current = null
    setHolding(null)
    jogCancel().catch(report)
  }, [report])

  const startHold = React.useCallback(
    (vec: JogVec) => {
      const o = optsRef.current
      if (!o.enabled) return
      if (hold.current) stopHold()
      const feed = vec.z && !vec.x && !vec.y ? o.zFeed : o.feed
      const inc = Math.min(50, (feed / 60) * (TICK_MS / 1000) * 1.3)
      const send = () => {
        const h = hold.current
        if (!h || h.inflight) return
        h.inflight = true
        jog({ dx: vec.x * inc, dy: vec.y * inc, dz: vec.z * inc }, feed)
          .catch((e) => {
            stopHold()
            report(e)
          })
          .finally(() => {
            if (hold.current === h) h.inflight = false
          })
      }
      hold.current = { vec, timer: setInterval(send, TICK_MS), inflight: false }
      setHolding(vec)
      send()
    },
    [report, stopHold],
  )

  React.useEffect(() => {
    const stop = () => stopHold()
    const vis = () => document.visibilityState !== 'visible' && stopHold()
    window.addEventListener('blur', stop)
    document.addEventListener('visibilitychange', vis)
    return () => {
      window.removeEventListener('blur', stop)
      document.removeEventListener('visibilitychange', vis)
      stopHold()
    }
  }, [stopHold])

  React.useEffect(() => {
    if (!opts.enabled) stopHold()
  }, [opts.enabled, stopHold])

  return { step, startHold, stopHold, holding }
}

/**
 * Pointer handlers for one jog button: click = step; in continuous mode, press-and-hold (>250 ms)
 * switches to streaming until release.
 */
export function useJogButton(j: ReturnType<typeof useJogger>, vec: JogVec, size: number, continuous: boolean) {
  const t = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const held = React.useRef(false)
  const suppressClick = React.useRef(false)
  const clear = () => {
    if (t.current) clearTimeout(t.current)
    t.current = null
  }
  const end = () => {
    clear()
    if (held.current) {
      held.current = false
      suppressClick.current = true
      j.stopHold()
    }
  }
  return {
    onPointerDown: (e: React.PointerEvent) => {
      if (e.button !== 0) return
      held.current = false
      suppressClick.current = false
      if (!continuous) return
      ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
      clear()
      t.current = setTimeout(() => {
        held.current = true
        j.startHold(vec)
      }, 250)
    },
    onPointerUp: end,
    onPointerCancel: end,
    onLostPointerCapture: end,
    onClick: () => {
      if (suppressClick.current) {
        suppressClick.current = false
        return
      }
      void j.step(vec, size)
    },
    onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
  }
}
