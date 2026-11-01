// Shell screenshots: light/dark × desktop 1440×900 / phone 390×844.
// usage: node scripts/screenshots.mjs [baseUrl] [outDir] [prefix] [path…]
import { mkdirSync } from 'node:fs'
import { chromium } from 'playwright'

const argv = process.argv.slice(2).filter((a) => a !== '--mock')
const MOCK = process.argv.includes('--mock')
const base = argv[0] ?? 'http://localhost:5173'
const out = argv[1] ?? 'screenshots'
const prefix = argv[2] ?? 'shell'
const paths = argv.slice(3).length ? argv.slice(3) : ['/studio']

// --mock: fake an authenticated backend with a connected FakeGrbl and a running job (no server needed).
const now = Date.now() / 1000
const machine = {
  connected: true, connecting: false, port: '/dev/serial/by-id/usb-1a86_USB_Serial-if00-port0', baud: 115200, fake: true,
  firmware: '1.1f', grbl_state: 'Run', state_text: '运行', wpos: [82.4, -121.3, 8], mpos: [82.4, -121.3, 8], wco: [0, 0, 0],
  feed: 1500, buf: { planner: 12, rx: 96 }, ov: [100, 100, 100], pins: '', pen: 'down', origin_valid: true, last_alarm: null,
  job_id: 'j1', busy: true, error: null, updated_at: now,
}
const job = {
  id: 'j1', name: '通知函 第1页', status: 'running', reason: null, batch_id: null, seq: 1, source: {}, overrides: {},
  total_lines: 5231, acked_line: 3557, sent_line: 3570, percent: 68, est_s: 1260, elapsed_s: 820, eta_s: 252, errors: [],
  out_of_work_area: false, created_at: now - 900, started_at: now - 820,
}
export async function mock(ctx) {
  await ctx.route('**/api/v1/**', (route) => {
    const u = new URL(route.request().url())
    const body = u.pathname.endsWith('/auth/state')
      ? { setup_required: false, authenticated: true, user: 'admin', csrf: true, setup_code_required: false, scopes: ['read', 'control', 'admin'], via: 'session', dev: true }
      : u.pathname.endsWith('/jobs') ? [{ ...job, id: 'j2', status: 'queued' }, { ...job, id: 'j3', status: 'queued' }]
      : u.pathname.endsWith('/system/health') ? { status: 'ok', version: '0.3.0', uptime_s: 100, machine_connected: true, job_active: true }
      : {}
    return route.fulfill({ json: body })
  })
  await ctx.routeWebSocket(/\/api\/v1\/ws/, (ws) => {
    ws.send(JSON.stringify({ type: 'hello', seq: 1, ts: now, server_version: '0.3.0', conn_id: 'c1', snapshot: { machine, job, tasks: [], batch: null } }))
    ws.onMessage((m) => {
      const msg = JSON.parse(String(m))
      if (msg.type === 'ping') ws.send(JSON.stringify({ type: 'pong', seq: 2, ts: now, t: msg.t }))
      if (msg.type === 'cmd') ws.send(JSON.stringify({ type: 'ack', seq: 3, ts: now, id: msg.id, ok: true, result: null, error: null }))
    })
  })
}
mkdirSync(out, { recursive: true })

if (process.env.SHOTS_LIB) { /* imported as a library */ } else await run()
async function run() {
const browser = await chromium.launch()
const shots = []
for (const scheme of ['light', 'dark']) {
  for (const [name, vp, mobile] of [['desktop', { width: 1440, height: 900 }, false], ['phone', { width: 390, height: 844 }, true]]) {
    const ctx = await browser.newContext({ viewport: vp, colorScheme: scheme, deviceScaleFactor: mobile ? 2 : 1, isMobile: mobile, hasTouch: mobile, locale: 'zh-CN' })
    if (MOCK) await mock(ctx)
    const page = await ctx.newPage()
    page.on('pageerror', (e) => console.error(`[pageerror ${name}/${scheme}]`, e.message))
    page.on('console', (m) => m.type() === 'error' && !/WebSocket|Failed to load resource|ERR_/.test(m.text()) && console.error(`[console ${name}/${scheme}]`, m.text()))
    for (const p of paths) {
      await page.goto(base + p, { waitUntil: 'networkidle' }).catch(() => {})
      await page.waitForTimeout(2500)
      const file = `${out}/${prefix}-${p.replace(/\W+/g, '_').replace(/^_|_$/g, '') || 'root'}-${name}-${scheme}.png`
      await page.screenshot({ path: file })
      shots.push(file)
    }
    await ctx.close()
  }
}
await browser.close()
console.log(shots.join('\n'))
}
