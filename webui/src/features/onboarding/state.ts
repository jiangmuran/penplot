/**
 * Setup-wizard progress. Persisted in app settings (`PATCH /settings {ui:{onboarding}}`, deep-merged
 * server-side) so it follows the user across devices; localStorage is the cache/fallback (no admin
 * scope, older backend, offline). Light module: safe to import from the shell.
 */
import { create } from 'zustand'
import { api } from '@/api/client'
import { qk, queryClient } from '@/api/query'

export const STEPS = [
  { id: 'welcome', title: '欢迎', hint: '大约 10 分钟' },
  { id: 'connect', title: '连接写字机', hint: '选端口，检查固件' },
  { id: 'pen', title: '认识你的笔', hint: '找到刚好接触纸的高度' },
  { id: 'paper', title: '放纸与原点', hint: '设原点，走边框' },
  { id: 'test', title: '试写', hint: '2 cm 方块 +「你好」' },
  { id: 'done', title: '完成', hint: '下一步做什么' },
] as const
export type StepId = (typeof STEPS)[number]['id']

export interface OnboardingData {
  port?: string
  penType?: 'Stepper' | 'Servo'
  touchZ?: number
  penDownZ?: number
  penUpZ?: number
  paper?: string
  fontId?: string
  testJobId?: string
  testResult?: string
}

export interface OnboardingState {
  v: 1
  step: StepId
  done: StepId[]
  skipped: StepId[]
  completed: boolean
  /** User chose「以后再说」: don't auto-open again. */
  dismissed: boolean
  updated_at: number
  data: OnboardingData
}

const LS_KEY = 'penplot.onboarding.v1'
const fresh = (): OnboardingState => ({ v: 1, step: 'welcome', done: [], skipped: [], completed: false, dismissed: false, updated_at: 0, data: {} })

function readLocal(): OnboardingState | null {
  try {
    const s = JSON.parse(localStorage.getItem(LS_KEY) ?? 'null')
    return s && s.v === 1 ? { ...fresh(), ...s } : null
  } catch {
    return null
  }
}

let saveTimer: ReturnType<typeof setTimeout> | null = null

interface Store {
  s: OnboardingState
  /** 'local' until the server copy was read (or failed). */
  source: 'local' | 'server' | 'local-only'
  loaded: boolean
  load: () => Promise<void>
  update: (patch: Partial<Omit<OnboardingState, 'data'>> & { data?: Partial<OnboardingData> }) => void
  reset: () => void
}

export const useOnboarding = create<Store>((set, get) => ({
  s: readLocal() ?? fresh(),
  source: 'local',
  loaded: false,
  load: async () => {
    try {
      // shares the cache entry (and an in-flight request) with useAppSettings()
      const st = await queryClient.fetchQuery({
        queryKey: qk.settings,
        queryFn: () => api.get<{ ui?: { onboarding?: OnboardingState } }>('/settings', { timeoutMs: 6000, skipAuthHandling: true }),
        staleTime: 10_000,
      }) as { ui?: { onboarding?: OnboardingState } }
      const remote = st?.ui?.onboarding
      if (remote && remote.v === 1 && remote.updated_at > get().s.updated_at) {
        const merged = { ...fresh(), ...remote }
        localStorage.setItem(LS_KEY, JSON.stringify(merged))
        set({ s: merged })
      }
      set({ source: 'server', loaded: true })
    } catch {
      set({ source: 'local-only', loaded: true })
    }
  },
  update: (patch) => {
    const cur = get().s
    const next: OnboardingState = { ...cur, ...patch, data: { ...cur.data, ...(patch.data ?? {}) }, updated_at: Date.now() / 1000 }
    set({ s: next })
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(next))
    } catch {
      /* private mode */
    }
    if (get().source === 'local-only') return
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      api.patch('/settings', { ui: { onboarding: get().s } }, { skipAuthHandling: true }).catch(() => set({ source: 'local-only' }))
    }, 600)
  },
  reset: () => get().update({ ...fresh(), updated_at: Date.now() / 1000 }),
}))

export const stepIndex = (id: StepId) => STEPS.findIndex((s) => s.id === id)
