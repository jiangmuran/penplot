/**
 * Page chrome plumbing: pages describe their title and toolbar items with <Page>; the shell's
 * toolbar (regular) or navigation bar (compact) renders them through portals.
 */
import type * as React from 'react'
import { createPortal } from 'react-dom'
import { create } from 'zustand'

export interface ChromeState {
  title: string
  subtitle?: React.ReactNode
  hasInspector: boolean
  largeTitleVisible: boolean
}

interface ChromeStore extends ChromeState {
  set: (p: Partial<ChromeState>) => void
  slots: { leading: HTMLElement | null; trailing: HTMLElement | null }
  setSlot: (name: 'leading' | 'trailing', el: HTMLElement | null) => void
  estopAnchor: HTMLElement | null
  setEstopAnchor: (el: HTMLElement | null) => void
}

/**
 * A store, not a context: a context value changes for every consumer at once, and pages update
 * `subtitle` (often a fresh JSX node) on each render — that used to re-render the toolbar, the
 * E-stop layer and the attention effects with every studio render (09-perf). Read it with a
 * selector: `useChrome((c) => c.title)`.
 */
const useChromeStore = create<ChromeStore>((setState, get) => ({
  title: '',
  subtitle: undefined,
  hasInspector: false,
  largeTitleVisible: true,
  set: (p) => {
    const cur = get()
    for (const k of Object.keys(p) as (keyof ChromeState)[]) {
      if (!Object.is(cur[k], p[k])) {
        setState(p)
        return
      }
    }
  },
  slots: { leading: null, trailing: null },
  setSlot: (name, el) => {
    const slots = get().slots
    if (slots[name] !== el) setState({ slots: { ...slots, [name]: el } })
  },
  estopAnchor: null,
  setEstopAnchor: (el) => {
    if (get().estopAnchor !== el) setState({ estopAnchor: el })
  },
}))

/** Kept for the provider tree; the state lives in a store. */
export function ChromeProvider({ children }: { children: React.ReactNode }) {
  return children
}

export function useChrome<T>(selector: (c: ChromeStore) => T): T {
  return useChromeStore(selector)
}

/** Render children into a toolbar slot ('leading' = after the title, 'trailing' = before status/E-stop). */
export function ToolbarPortal({ slot, children }: { slot: 'leading' | 'trailing'; children: React.ReactNode }) {
  const el = useChrome((c) => c.slots[slot])
  return el ? createPortal(children, el) : null
}
