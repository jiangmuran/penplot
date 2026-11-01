/**
 * Tracks open overlays that the floating E-stop must avoid (05-review §0-2).
 * Bottom sheets register themselves (components/ui/sheet.tsx); while one is open on compact, the
 * E-stop moves to the top-right corner (above the sheet, over the dimmed backdrop) instead of
 * covering the sheet's content in the machine bar position.
 */
import { useEffect } from 'react'
import { create } from 'zustand'

interface OverlayState {
  bottomSheets: number
}
export const useOverlays = create<OverlayState>(() => ({ bottomSheets: 0 }))

/** Call from a mounted bottom sheet. */
export function useRegisterBottomSheet(active: boolean) {
  useEffect(() => {
    if (!active) return
    useOverlays.setState((s) => ({ bottomSheets: s.bottomSheets + 1 }))
    return () => useOverlays.setState((s) => ({ bottomSheets: Math.max(0, s.bottomSheets - 1) }))
  }, [active])
}
