// Builds webui into e2e/.webui-dist (never touches webui/dist) for the backend to serve
// via PENPLOT_STATIC_DIR. Then verifies every pre-compressed .gz/.br sibling decompresses to
// exactly the plain asset; mismatching siblings are recorded in .precompress-report.json and
// removed so the app under test is usable (see FINDINGS.md F1).
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const e2e = path.resolve(here, '..')
const webui = path.resolve(e2e, '../webui')
const out = path.join(e2e, '.webui-dist')

if (process.env.E2E_SKIP_BUILD === '1' && fs.existsSync(path.join(out, 'index.html'))) {
  console.log('[e2e] E2E_SKIP_BUILD=1, reusing', out)
  process.exit(0)
}
console.log('[e2e] building webui ->', out)
execFileSync(path.join(webui, 'node_modules/.bin/vite'), ['build', '--outDir', out, '--emptyOutDir', '--logLevel', 'warn'], {
  cwd: webui,
  stdio: 'inherit',
})

const report = { checked: 0, mismatched: [] }
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]))
for (const f of walk(out)) {
  const m = f.match(/\.(gz|br)$/)
  if (!m) continue
  const plain = f.slice(0, -m[0].length)
  if (!fs.existsSync(plain)) continue
  report.checked++
  const buf = fs.readFileSync(f)
  const dec = m[1] === 'gz' ? zlib.gunzipSync(buf) : zlib.brotliDecompressSync(buf)
  if (!dec.equals(fs.readFileSync(plain))) {
    report.mismatched.push({ file: path.relative(out, f), hasPreloadMarker: dec.includes('__VITE_PRELOAD__') })
    fs.unlinkSync(f)
  }
}
fs.writeFileSync(path.join(e2e, '.precompress-report.json'), JSON.stringify(report, null, 2))
console.log(`[e2e] precompressed siblings checked=${report.checked} mismatched(removed)=${report.mismatched.length}`)
