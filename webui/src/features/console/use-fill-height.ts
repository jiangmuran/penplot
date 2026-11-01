import * as React from 'react'

/**
 * Height that makes `ref` fill the rest of the shell's scroll container (#main) below its top edge,
 * minus `bottom` px. Used for full-height panels (console log) inside a padded <Page>.
 */
export function useFillHeight(ref: React.RefObject<HTMLElement | null>, bottom = 16, min = 280) {
  const [h, setH] = React.useState<number | null>(null)
  React.useLayoutEffect(() => {
    const el = ref.current
    const main = document.getElementById('main')
    if (!el || !main) return
    const update = () => {
      const top = el.getBoundingClientRect().top - main.getBoundingClientRect().top + main.scrollTop
      setH(Math.max(min, Math.floor(main.clientHeight - top - bottom)))
    }
    update()
    const ro = new ResizeObserver(update)
    ro.observe(main)
    if (el.parentElement) ro.observe(el.parentElement)
    window.addEventListener('resize', update)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', update)
    }
  }, [ref, bottom, min])
  return h
}
