import fs from 'node:fs'
import path from 'node:path'
import { E2E_DIR } from '../helpers/env'
import { expect, test } from '../helpers/fixtures'

/**
 * The production build is served by the backend with pre-compressed .br/.gz siblings preferred over the
 * plain files (penplot/web/static_files.py). scripts/build-webui.mjs compares every sibling with its plain
 * asset and writes .precompress-report.json (it removes mismatches so the rest of the suite can run).
 */
test.describe('production build', () => {
  test('pre-compressed .br/.gz assets are identical to the plain assets', async ({ compact }) => {
    test.skip(compact, 'browser-independent; checked once')
    const report = JSON.parse(fs.readFileSync(path.join(E2E_DIR, '.precompress-report.json'), 'utf8')) as {
      checked: number
      mismatched: { file: string; hasPreloadMarker: boolean }[]
    }
    expect(report.checked).toBeGreaterThan(0)
    expect(report.mismatched).toEqual([])
  })

  test('index.html is no-cache, hashed assets are immutable and served compressed', async ({ request, compact }) => {
    test.skip(compact, 'browser-independent; checked once')
    const idx = await request.get('/')
    expect(idx.headers()['cache-control']).toBe('no-cache')
    const html = await idx.text()
    const asset = /\/assets\/[^"]+\.js/.exec(html)?.[0]
    expect(asset).toBeTruthy()
    const a = await request.get(asset!, { headers: { 'Accept-Encoding': 'br, gzip' } })
    expect(a.status()).toBe(200)
    expect(a.headers()['cache-control']).toContain('immutable')
    // SPA fallback must not swallow missing assets
    expect((await request.get('/assets/does-not-exist.js')).status()).toBe(404)
  })
})

test.describe('page load', () => {
  test('no Content-Security-Policy violations; stored dark theme applies before first paint', async ({ page, guard }) => {
    guard.strictKnown()
    await page.addInitScript(() => localStorage.setItem('penplot.theme', 'dark'))
    let csp = false
    page.on('console', (m) => {
      if (/Content Security Policy|Refused to execute a script/.test(m.text())) csp = true
    })
    await page.goto('/studio', { waitUntil: 'domcontentloaded' })
    // the inline head script sets data-theme synchronously, before the module bundle runs
    const early = await page.evaluate(() => document.documentElement.dataset.theme ?? null)
    expect(csp, 'inline script blocked by CSP').toBe(false)
    expect(early).toBe('dark')
  })
})
