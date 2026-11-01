/**
 * Global keyboard shortcut registry (02-ux §5.2). One capture-phase keydown listener on window.
 *
 *   const off = registerShortcut({ id: 'studio.preview', keys: 'mod+enter', description: '立即预览',
 *                                  group: '创作台', handler: () => preview() })
 *   // or in a component:
 *   useShortcut('mod+p', () => openPrint(), { description: '打印', group: '创作台' })
 *
 * Key syntax: modifiers `mod` (⌘ on Apple, Ctrl elsewhere), `ctrl`, `alt`, `shift` joined with `+`,
 * then a key: a letter/digit, `.`, `/`, `?`, `[`, `]`, `=`, `-`, `space`, `enter`, `escape`, `delete`,
 * `backspace`, `arrowup|down|left|right`, `pageup`, `pagedown`, `tab`.
 * Later registrations win. A handler returning `false` passes the event on to the next one.
 * Shortcuts without a modifier never fire while typing in an editable element unless `allowInEditable`.
 */
import { useEffect, useRef, useSyncExternalStore } from 'react'
import { isEditableTarget, isMac, modKeyLabel } from './platform'

export interface Shortcut {
  id: string
  keys: string
  handler: (e: KeyboardEvent) => void | boolean
  description?: string
  group?: string
  /** Fire even when focus is in an input/textarea (e.g. Mod+. E-stop). */
  allowInEditable?: boolean
  /** Extra guard evaluated at key time. */
  when?: () => boolean
  /** Hide from the shortcut cheat-sheet. */
  hidden?: boolean
}

interface Parsed {
  mod: boolean
  ctrl: boolean
  alt: boolean
  shift: boolean
  key: string
}

const CODE_KEYS: Record<string, string> = {
  Period: '.', Comma: ',', Slash: '/', BracketLeft: '[', BracketRight: ']', Equal: '=', Minus: '-',
  Space: 'space', Enter: 'enter', NumpadEnter: 'enter', Escape: 'escape', Delete: 'delete',
  Backspace: 'backspace', ArrowUp: 'arrowup', ArrowDown: 'arrowdown', ArrowLeft: 'arrowleft',
  ArrowRight: 'arrowright', PageUp: 'pageup', PageDown: 'pagedown', Tab: 'tab', Backquote: '`',
}
/** Keys that are typed with shift on most layouts; their shift state is not compared. */
const SHIFTED = new Set(['?', '+', '!', '~'])

function parse(keys: string): Parsed {
  const parts = keys.toLowerCase().split('+').map((s) => s.trim())
  // "mod++" style: trailing empty part means '+'
  let key = parts.pop() ?? ''
  if (key === '' && keys.endsWith('+')) key = '+'
  const p: Parsed = { mod: false, ctrl: false, alt: false, shift: false, key }
  for (const m of parts) {
    if (m === 'mod' || m === 'cmd' || m === 'meta') p.mod = true
    else if (m === 'ctrl') p.ctrl = true
    else if (m === 'alt' || m === 'option') p.alt = true
    else if (m === 'shift') p.shift = true
  }
  return p
}

function eventKey(e: KeyboardEvent): string {
  const c = e.code
  if (c.startsWith('Key')) return c.slice(3).toLowerCase()
  if (c.startsWith('Digit')) return c.slice(5)
  if (c.startsWith('Numpad') && /\d$/.test(c)) return c.slice(-1)
  if (CODE_KEYS[c]) return CODE_KEYS[c]
  return e.key.toLowerCase()
}

function matches(p: Parsed, e: KeyboardEvent): boolean {
  // On non-Apple platforms `ctrl` and `mod` are the same key.
  const wantMod = isMac ? p.mod : p.mod || p.ctrl
  const modPressed = isMac ? e.metaKey : e.ctrlKey
  if (wantMod !== modPressed) return false
  if (isMac && p.ctrl !== e.ctrlKey) return false
  if (!isMac && e.metaKey) return false
  if (p.alt !== e.altKey) return false
  if (SHIFTED.has(p.key)) return e.key === p.key
  if (p.shift !== e.shiftKey) return false
  return eventKey(e) === p.key
}

type Entry = Shortcut & { parsed: Parsed; order: number }
const entries = new Map<string, Entry>()
let order = 0
let version = 0
const listeners = new Set<() => void>()
let installed = false

function emit() {
  version++
  listeners.forEach((l) => l())
}

export function singleKeyShortcutsEnabled(): boolean {
  return localStorage.getItem('penplot.singleKey') !== '0'
}
export function setSingleKeyShortcutsEnabled(on: boolean) {
  localStorage.setItem('penplot.singleKey', on ? '1' : '0')
}

function onKeyDown(e: KeyboardEvent) {
  if (e.isComposing || e.keyCode === 229) return // IME (拼音) composition
  const editable = isEditableTarget(e.target)
  const sorted = [...entries.values()].sort((a, b) => b.order - a.order)
  for (const s of sorted) {
    if (!matches(s.parsed, e)) continue
    const hasModifier = s.parsed.mod || s.parsed.ctrl || s.parsed.alt
    if (editable && !s.allowInEditable) {
      // While typing only Mod-combos fire, and never the text-editing ones.
      if (!(s.parsed.mod || s.parsed.ctrl)) continue
      if (['c', 'v', 'x', 'a', 'z', 'arrowleft', 'arrowright', 'backspace'].includes(s.parsed.key)) continue
    }
    if (!hasModifier && !singleKeyShortcutsEnabled() && s.parsed.key.length === 1) continue
    if (s.when && !s.when()) continue
    const r = s.handler(e)
    if (r === false) continue
    e.preventDefault()
    e.stopPropagation()
    return
  }
}

function install() {
  if (installed || typeof window === 'undefined') return
  installed = true
  window.addEventListener('keydown', onKeyDown, { capture: true })
}

export function registerShortcut(s: Shortcut): () => void {
  install()
  const entry: Entry = { ...s, parsed: parse(s.keys), order: ++order }
  entries.set(s.id, entry)
  emit()
  return () => {
    if (entries.get(s.id) === entry) {
      entries.delete(s.id)
      emit()
    }
  }
}

/** Register a shortcut for the lifetime of a component. The handler may change between renders. */
export function useShortcut(
  keys: string,
  handler: (e: KeyboardEvent) => void | boolean,
  opts: Omit<Shortcut, 'keys' | 'handler' | 'id'> & { id?: string; enabled?: boolean } = {},
) {
  const ref = useRef(handler)
  ref.current = handler
  const { enabled = true, id, description, group, allowInEditable, hidden } = opts
  const whenRef = useRef(opts.when)
  whenRef.current = opts.when
  useEffect(() => {
    if (!enabled) return
    return registerShortcut({
      id: id ?? `${keys}#${Math.random().toString(36).slice(2)}`,
      keys,
      description,
      group,
      allowInEditable,
      hidden,
      when: () => (whenRef.current ? whenRef.current() : true),
      handler: (e) => ref.current(e),
    })
  }, [keys, enabled, id, description, group, allowInEditable, hidden])
}

/** Live list of described shortcuts for the "?" cheat-sheet. */
export function useShortcutList(): Shortcut[] {
  useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => version,
  )
  const seen = new Set<string>()
  return [...entries.values()]
    .filter((s) => s.description && !s.hidden)
    .sort((a, b) => a.order - b.order)
    .filter((s) => {
      const k = `${s.group}|${s.keys}`
      if (seen.has(k)) return false
      seen.add(k)
      return true
    })
}

/** Human label: "mod+shift+e" → "⌘⇧E" (Apple) / "Ctrl+Shift+E". */
export function formatKeys(keys: string): string[] {
  const p = parse(keys)
  const out: string[] = []
  const names: Record<string, string> = {
    space: 'Space', enter: '↵', escape: 'Esc', delete: 'Delete', backspace: '⌫', arrowup: '↑',
    arrowdown: '↓', arrowleft: '←', arrowright: '→', pageup: 'PgUp', pagedown: 'PgDn', tab: 'Tab',
  }
  if (isMac) {
    if (p.ctrl) out.push('⌃')
    if (p.alt) out.push('⌥')
    if (p.shift) out.push('⇧')
    if (p.mod) out.push('⌘')
  } else {
    if (p.mod || p.ctrl) out.push('Ctrl')
    if (p.alt) out.push('Alt')
    if (p.shift) out.push('Shift')
  }
  out.push(names[p.key] ?? p.key.toUpperCase())
  return out
}
export { modKeyLabel }
