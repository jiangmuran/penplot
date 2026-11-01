// Generate src/api/schema.d.ts from docs/design/openapi.json with openapi-typescript.
// openapi-typescript needs TypeScript 5's compiler API, so it lives in tools/openapi with its own
// node_modules (installed on first run).
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const tools = resolve(root, 'tools/openapi')
const bin = resolve(tools, 'node_modules/openapi-typescript/bin/cli.js')
const spec = resolve(root, '../docs/design/openapi.json')
const out = resolve(root, 'src/api/schema.d.ts')

if (!existsSync(spec)) {
  console.error(`missing ${spec} — run: .venv/bin/python -m penplot.web dump-openapi > docs/design/openapi.json`)
  process.exit(1)
}
if (!existsSync(bin)) {
  console.log('installing openapi-typescript into tools/openapi …')
  execFileSync('npm', ['install', '--no-audit', '--no-fund'], { cwd: tools, stdio: 'inherit' })
}
execFileSync(process.execPath, [bin, spec, '-o', out, '--root-types', '--root-types-no-schema-prefix'], { stdio: 'inherit' })
