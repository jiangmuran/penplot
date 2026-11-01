import { test as base, expect, type Locator, type Page, type TestInfo } from '@playwright/test'
import { Api } from './api'

/**
 * Endpoints the frontend already calls but the backend does not serve yet (webui/src/api/collab.ts
 * "ASSUMED CONTRACT"). The UI is expected to degrade gracefully on 404 for these. Each hit is recorded
 * as an annotation so the report shows it, but it does not fail the test.
 */
export const PENDING_ENDPOINTS = [/\/api\/v1\/machine\/lease$/, /\/api\/v1\/auth\/me$/, /\/api\/v1\/presence$/, /\/api\/v1\/users$/, /\/api\/v1\/system\/diagnostics/]

/** Console noise that is not an app error. */
const IGNORED_CONSOLE = [
  /Failed to load resource/, // network-level errors are judged by status below instead
  /Viewport argument key "interactive-widget" not recognized/, // WebKit does not know this meta key
  /WebSocket connection to .* failed/, // expected while a test takes the backend down
  /WebSocket is closed before the connection is established/,
]

/**
 * Console errors caused by an already documented bug (FINDINGS.md). They are recorded as a
 * `known-bug` annotation instead of failing every test; each has a dedicated strict test.
 */
const KNOWN_BUG_CONSOLE: { id: string; re: RegExp }[] = [
]

export interface Guard {
  /** Additionally tolerate console errors / HTTP failures matching this pattern for this test. */
  allow(pattern: RegExp): void
  /** Fail on 4xx API responses too (except PENDING_ENDPOINTS and allowed patterns). */
  strict4xx(): void
  /** Also fail on console errors of already documented bugs (used by the bug's own test). */
  strictKnown(): void
  problems(): string[]
}

function attachGuard(page: Page, info: TestInfo): Guard {
  const problems: string[] = []
  const allowed: RegExp[] = []
  let strict = false
  let strictKnown = false
  const ok = (s: string) => allowed.some((a) => a.test(s))
  page.on('pageerror', (e) => {
    const s = `uncaught exception: ${e.message}`
    // WebKit rejects in-flight same-origin fetches with "… due to access control checks" when the page
    // navigates away mid-request; the app is same-origin, so this only happens during unload.
    if (/due to access control checks\.?$/.test(e.message) && new RegExp(`${new URL(page.url()).host}`).test(e.message)) return
    if (!ok(s)) problems.push(s)
  })
  page.on('console', (m) => {
    if (m.type() !== 'error') return
    const t = m.text()
    if (IGNORED_CONSOLE.some((r) => r.test(t)) || ok(t)) return
    const known = KNOWN_BUG_CONSOLE.find((k) => k.re.test(t))
    if (known && !strictKnown) {
      if (!info.annotations.some((a) => a.type === 'known-bug' && a.description?.startsWith(known.id)))
        info.annotations.push({ type: 'known-bug', description: `${known.id}: ${t.slice(0, 160)}` })
      return
    }
    problems.push(`console.error: ${t}`)
  })
  page.on('response', (r) => {
    const url = r.url()
    const st = r.status()
    if (st < 400) return
    const path = new URL(url).pathname
    if (PENDING_ENDPOINTS.some((p) => p.test(path))) {
      if (!info.annotations.some((a) => a.type === 'pending-endpoint' && a.description === path))
        info.annotations.push({ type: 'pending-endpoint', description: path })
      return
    }
    const s = `HTTP ${st} ${r.request().method()} ${path}`
    if (ok(s)) return
    if (st >= 500 || (strict && path.startsWith('/api/'))) problems.push(s)
  })
  return {
    allow: (p) => void allowed.push(p),
    strict4xx: () => void (strict = true),
    strictKnown: () => void (strictKnown = true),
    problems: () => problems,
  }
}

export interface App {
  page: Page
  compact: boolean
  /** Navigate and wait until the shell is up and the live WebSocket is open. */
  goto(path: string): Promise<void>
  /** Status pill (always rendered on desktop; on compact only while no job is shown in the machine bar). */
  statusPill(): Locator
  /** Wait until the WebSocket is open and the server snapshot arrived. */
  waitLive(): Promise<void>
  /** Navigate via the real navigation UI: sidebar (desktop) or tab bar / 更多 sheet (compact). */
  nav(label: string): Promise<void>
  estop(): Locator
  /** The global mini-player: sidebar card (desktop) or machine bar (compact). */
  miniPlayer(): Locator
  /** Confirm the topmost alert dialog with the given button label. */
  confirm(label: string): Promise<void>
}

/** Compact tab-bar short labels (webui/src/app/nav.ts `short`). */
const SHORT: Record<string, string> = { 创作台: '创作', 项目与模板: '项目' }

function makeApp(page: Page, compact: boolean): App {
  const statusPill = () => page.getByRole('button', { name: /^机器状态：/ })
  const app: App = {
    page,
    compact,
    statusPill,
    async waitLive() {
      // offline labels: "设备离线", "设备离线 · 重连中", "正在连接…"
      const ready = page.getByRole('button', { name: /^机器状态：(?!设备离线|正在连接)/ }).or(page.getByRole('button', { name: '打开任务' })).or(page.getByRole('button', { name: /^当前任务：/ }))
      await expect(ready.first()).toBeVisible({ timeout: 20_000 })
    },
    async goto(path) {
      await page.goto(path)
      await expect(page.locator('#main')).toBeVisible()
      await expect(page.getByRole('heading', { name: '页面出错了' })).toHaveCount(0)
      await app.waitLive()
    },
    async nav(label) {
      const navEl = page.getByRole('navigation', { name: '主导航' })
      if (!compact) {
        await navEl.getByRole('link', { name: label, exact: true }).click()
        return
      }
      // the compact tab bar uses short labels and its set of tabs is still evolving: try a tab first
      const names = [label, SHORT[label]].filter(Boolean) as string[]
      for (const n of names) {
        const tab = navEl.getByRole('link', { name: n, exact: true })
        if (await tab.count()) {
          await tab.click()
          return
        }
      }
      await navEl.getByRole('button', { name: '更多' }).click()
      const sheet = page.getByRole('dialog', { name: '更多' })
      await sheet.getByRole('button', { name: label, exact: true }).click()
      await expect(sheet).toBeHidden()
    },
    estop: () => page.getByRole('button', { name: '急停', exact: true }).last(),
    miniPlayer: () => (compact ? page.getByRole('button', { name: '打开任务' }) : page.getByRole('button', { name: /^当前任务：/ })),
    async confirm(label) {
      const dlg = page.getByRole('alertdialog').last()
      await expect(dlg).toBeVisible()
      await dlg.getByRole('button', { name: label, exact: true }).click()
      await expect(dlg).toBeHidden()
    },
  }
  return app
}

type Fixtures = { guard: Guard; app: App; compact: boolean; api: Api; machine: Api; jogSeqShim: boolean; _shims: void }
type WorkerFixtures = { workerApi: Api }

export const test = base.extend<Fixtures, WorkerFixtures>({
  workerApi: [
    async ({}, use) => {
      const api = await Api.session()
      await use(api)
      await api.dispose()
    },
    { scope: 'worker' },
  ],
  api: async ({ workerApi }, use) => {
    // sessions survive backend restarts (SQLite), so the worker session stays valid
    await use(workerApi)
  },
  /** Same as `api`, but resets the simulated plotter to Idle / no active job first. */
  machine: async ({ workerApi }, use) => {
    await workerApi.resetMachine()
    await use(workerApi)
  },
  compact: async ({ viewport }, use) => {
    await use((viewport?.width ?? 1440) < 768)
  },
  guard: [
    async ({ page }, use, info) => {
      const g = attachGuard(page, info)
      await use(g)
      const p = g.problems()
      if (p.length) info.annotations.push({ type: 'console-problems', description: p.join('\n') })
      expect(p, 'no console errors, uncaught exceptions or HTTP 5xx during the test').toEqual([])
    },
    { auto: true },
  ],
  app: async ({ page, compact }, use) => {
    await use(makeApp(page, compact))
  },
  /**
   * Contract shim for FINDINGS F4 (jog dedupe): the backend dedupes jog `seq` globally, but every page load
   * restarts its seq at 1, so jogs from a reloaded page / second client are silently dropped. The shim makes
   * outgoing jog seqs globally increasing. The F4 test turns it off.
   */
  jogSeqShim: [true, { option: true }],
  _shims: [
    async ({ page, jogSeqShim }, use) => {
      const patchJog = (m: string) => {
        if (!jogSeqShim || !m.includes('"jog"')) return m
        try {
          const msg = JSON.parse(m)
          if (msg.type === 'cmd' && msg.op === 'jog' && msg.args && typeof msg.args.seq === 'number') {
            msg.args.seq = nextSeq()
            return JSON.stringify(msg)
          }
        } catch {
          /* not JSON */
        }
        return m
      }
      if (jogSeqShim) {
        await page.route(/\/api\/v1\/machine\/jog$/, async (route) => {
          const body = route.request().postDataJSON() as { seq?: number } | null
          if (body && typeof body.seq === 'number') return route.continue({ postData: JSON.stringify({ ...body, seq: nextSeq() }) })
          return route.continue()
        })
      }
      if (jogSeqShim) {
        await page.routeWebSocket(/\/api\/v1\/ws/, (ws) => {
          const server = ws.connectToServer()
          ws.onMessage((m) => server.send(typeof m === 'string' ? patchJog(m) : m))
          server.onMessage((m) => ws.send(m))
        })
      }
      await use()
    },
    { auto: true },
  ],
})

/** Globally increasing jog seq (ms clock × 1000 + counter) — larger than any seq a real page sends. */
let seqN = 0
const nextSeq = () => Date.now() * 1000 + (seqN++ % 1000)

export { expect }

/**
 * Feature probe: true when the route still renders the shell's "coming soon" placeholder
 * (webui/src/app/placeholder-page.tsx). Used to turn tests into test.fixme until the feature lands.
 */
export async function isPlaceholder(page: Page) {
  return (await page.getByText('此页面正在建设中').count()) > 0
}

/**
 * Marks the current test as an expected failure caused by a documented bug (FINDINGS.md). When the
 * bug is fixed the test "unexpectedly passes" and Playwright reports it, so the marker gets removed.
 */
export function knownBug(id: string, summary: string, condition = true) {
  test.fail(condition, `KNOWN BUG ${id} (see FINDINGS.md): ${summary}`)
}
