/**
 * Getting the user's attention when the plotter needs them (05-review §0-3, §3.6):
 * sound (Web Audio, unlocked on the first tap), vibration, browser Notification, title flashing,
 * PWA app badge, plus the in-app attention banner state.
 *
 *   alertUser({ kind: 'paper', title: '第 1 页写完了，请换纸', body: '通知函' })
 *   playTone('done')                          // preview in settings
 *   await requestNotifications()              // MUST be called from a click handler
 *   const prefs = useAttentionPrefs()         // { sound, notify, vibrate, wakeLock }
 *
 * The shell (src/app/attention.tsx) decides *when* to call alertUser from WS events; pages normally
 * don't need to.
 */
import { create } from 'zustand'

export type AttentionKind = 'done' | 'paper' | 'error' | 'alarm' | 'info'

export interface AttentionPrefs {
  sound: boolean
  notify: boolean
  vibrate: boolean
  /** Keep the screen on while a job is running and the page is visible. */
  wakeLock: boolean
}

const PREFS_KEY = 'penplot.attention'
const DEFAULT_PREFS: AttentionPrefs = { sound: true, notify: true, vibrate: true, wakeLock: true }

function loadPrefs(): AttentionPrefs {
  try {
    return { ...DEFAULT_PREFS, ...(JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as Partial<AttentionPrefs>) }
  } catch {
    return DEFAULT_PREFS
  }
}

/** In-app attention item shown by the shell's banner until resolved or dismissed. */
export interface AttentionItem {
  id: string
  kind: AttentionKind
  title: string
  body?: string
  jobId?: string
  batchId?: string | null
  nextJobId?: string | null
  sessionId?: string | null
  code?: string
  at: number
}

interface AttentionState {
  prefs: AttentionPrefs
  item: AttentionItem | null
  /** Text alternated into document.title while the tab is in the background. */
  flash: string | null
  setPrefs: (p: Partial<AttentionPrefs>) => void
  show: (i: Omit<AttentionItem, 'id' | 'at'>) => void
  dismiss: (id?: string) => void
}

export const useAttention = create<AttentionState>((set, get) => ({
  prefs: loadPrefs(),
  item: null,
  flash: null,
  setPrefs: (p) => {
    const prefs = { ...get().prefs, ...p }
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs))
    } catch {
      /* ignore */
    }
    set({ prefs })
  },
  show: (i) => set({ item: { ...i, id: `${i.kind}:${i.jobId ?? ''}:${Date.now()}`, at: Date.now() } }),
  dismiss: (id) => {
    const cur = get().item
    if (!cur || (id && cur.id !== id)) return
    set({ item: null, flash: null })
    clearBadge()
  },
}))

export const useAttentionPrefs = () => useAttention((s) => s.prefs)
export const setAttentionPrefs = (p: Partial<AttentionPrefs>) => useAttention.getState().setPrefs(p)

// ---------------------------------------------------------------- sound
let ctx: AudioContext | null = null

function audio(): AudioContext | null {
  if (ctx) return ctx
  const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!AC) return null
  try {
    ctx = new AC()
  } catch {
    ctx = null
  }
  return ctx
}

/** iOS/Safari only allow audio after a user gesture: create/resume the context on the first tap. */
export function installAudioUnlock() {
  const unlock = () => {
    const a = audio()
    if (a && a.state === 'suspended') void a.resume()
    // A silent blip fully unlocks iOS.
    if (a) {
      const o = a.createOscillator()
      const g = a.createGain()
      g.gain.value = 0
      o.connect(g).connect(a.destination)
      o.start()
      o.stop(a.currentTime + 0.01)
    }
    window.removeEventListener('pointerdown', unlock, true)
    window.removeEventListener('keydown', unlock, true)
  }
  window.addEventListener('pointerdown', unlock, true)
  window.addEventListener('keydown', unlock, true)
}

type Note = [freq: number, start: number, dur: number, type?: OscillatorType, gain?: number]

const TONES: Record<AttentionKind, Note[]> = {
  // bright rising chime
  done: [[784, 0, 0.18], [988, 0.14, 0.18], [1319, 0.28, 0.42]],
  // "ding-dong" ×2 — clearly different, asks for an action
  paper: [[880, 0, 0.32], [659, 0.3, 0.45], [880, 0.95, 0.32], [659, 1.25, 0.45]],
  // low urgent triple
  error: [[440, 0, 0.14, 'square', 0.12], [440, 0.2, 0.14, 'square', 0.12], [349, 0.4, 0.3, 'square', 0.12]],
  alarm: [[523, 0, 0.16, 'sawtooth', 0.1], [392, 0.2, 0.16, 'sawtooth', 0.1], [523, 0.4, 0.16, 'sawtooth', 0.1], [392, 0.6, 0.3, 'sawtooth', 0.1]],
  info: [[880, 0, 0.2]],
}

/** Play one of the attention tones (no-op if audio is unavailable or still locked). */
export function playTone(kind: AttentionKind) {
  const a = audio()
  if (!a) return
  if (a.state === 'suspended') void a.resume()
  const t0 = a.currentTime + 0.02
  for (const [f, s, d, type = 'sine', peak = 0.25] of TONES[kind]) {
    const o = a.createOscillator()
    const g = a.createGain()
    o.type = type
    o.frequency.value = f
    g.gain.setValueAtTime(0, t0 + s)
    g.gain.linearRampToValueAtTime(peak, t0 + s + 0.015)
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + s + d)
    o.connect(g).connect(a.destination)
    o.start(t0 + s)
    o.stop(t0 + s + d + 0.05)
  }
}

// ---------------------------------------------------------------- notifications
export type NotifyState = 'unsupported' | 'default' | 'granted' | 'denied'

export function isIOS() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
}
/** Running as an installed PWA (home-screen app). */
export function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true
}

export function notificationState(): NotifyState {
  if (typeof Notification === 'undefined') return 'unsupported'
  return Notification.permission as NotifyState
}

/** Ask for notification permission. Call only from a user gesture (click). */
export async function requestNotifications(): Promise<NotifyState> {
  if (typeof Notification === 'undefined') return 'unsupported'
  try {
    const r = await Notification.requestPermission()
    localStorage.setItem('penplot.notifyAsked', '1')
    return r as NotifyState
  } catch {
    return notificationState()
  }
}
export const notificationsAsked = () => localStorage.getItem('penplot.notifyAsked') === '1'
export const markNotificationsAsked = () => localStorage.setItem('penplot.notifyAsked', '1')

async function showNotification(title: string, body?: string, tag?: string) {
  if (notificationState() !== 'granted') return
  const opts: NotificationOptions = { body, tag, icon: '/icons/icon-192.png', badge: '/icons/icon-192.png' }
  try {
    // Prefer the service-worker path when one exists (required on iOS home-screen apps / Android).
    const reg = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : undefined
    if (reg) await reg.showNotification(title, opts)
    else new Notification(title, opts)
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------- badge & title
function setBadge() {
  const n = navigator as { setAppBadge?: (n?: number) => Promise<void> }
  void n.setAppBadge?.(1).catch(() => {})
}
export function clearBadge() {
  const n = navigator as { clearAppBadge?: () => Promise<void> }
  void n.clearAppBadge?.().catch(() => {})
}

const FLASH: Partial<Record<AttentionKind, string>> = {
  paper: '⏸ 请换纸',
  error: '⚠︎ 需要处理',
  alarm: '⚠︎ 写字机报警',
  done: '✓ 已写完',
}

// ---------------------------------------------------------------- main entry
export interface AlertInput {
  kind: AttentionKind
  title: string
  body?: string
  /** Notification tag (replaces older notifications with the same tag). */
  tag?: string
  /** Also show the in-app attention banner (paper/error). */
  banner?: { jobId?: string; batchId?: string | null; nextJobId?: string | null; sessionId?: string | null; code?: string }
  /** Sound/vibration only: no system notification, no title flash. */
  quiet?: boolean
}

/** Sound + vibration + system notification (when the tab is not in front) + title flash + banner. */
export function alertUser(a: AlertInput) {
  const st = useAttention.getState()
  const { prefs } = st
  if (prefs.sound) playTone(a.kind)
  if (prefs.vibrate && 'vibrate' in navigator) {
    try {
      navigator.vibrate(a.kind === 'done' ? [120, 80, 120] : [300, 120, 300, 120, 300])
    } catch {
      /* ignore */
    }
  }
  const background = !a.quiet && (document.visibilityState !== 'visible' || !document.hasFocus())
  if (prefs.notify && background) void showNotification(a.title, a.body, a.tag ?? `penplot-${a.kind}`)
  if (background) {
    setBadge()
    if (FLASH[a.kind]) useAttention.setState({ flash: FLASH[a.kind]! })
  }
  if (a.banner) st.show({ kind: a.kind, title: a.title, body: a.body, ...a.banner })
}

/** Stop title flashing / badge once the user is back. */
export function acknowledgeAttention() {
  if (useAttention.getState().flash) useAttention.setState({ flash: null })
  clearBadge()
}
