// Test backend supervisor (used as Playwright's webServer command).
//
// 1. builds webui into e2e/.webui-dist (scripts/build-webui.mjs)
// 2. creates an isolated temp data dir
// 3. runs `python -m penplot.web serve` with FakeGrbl and the private SPA build
// 4. restarts the backend whenever it exits (like systemd's Restart=always), so tests can
//    exercise /system/restart and kill-based restarts. While the file .run/hold exists the
//    supervisor waits before respawning (deterministic "server is down" windows).
//
// Run state for the tests is written to .run/state.json: {dataDir, port, baseURL, backendPid, ...}.
import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const e2e = path.resolve(here, '..')
const repo = path.resolve(e2e, '..')
const runDir = path.join(e2e, '.run')
const stateFile = path.join(runDir, 'state.json')
const holdFile = path.join(runDir, 'hold')
const port = Number(process.env.E2E_PORT ?? 8093)
const host = '127.0.0.1'

execFileSync(process.execPath, [path.join(here, 'build-webui.mjs')], { stdio: 'inherit' })

fs.mkdirSync(runDir, { recursive: true })
fs.rmSync(holdFile, { force: true })
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'penplot-e2e-'))
const python = process.env.E2E_PYTHON ?? path.join(repo, '.venv/bin/python')
const env = {
  ...process.env,
  PENPLOT_DEV: '1',
  PENPLOT_DATA_DIR: dataDir,
  PENPLOT_SERIAL_PORT: 'fake',
  PENPLOT_FAKE_TIME_SCALE: process.env.E2E_FAKE_TIME_SCALE ?? '0.05',
  PENPLOT_PORT: String(port),
  PENPLOT_HOST: host,
  PENPLOT_STATIC_DIR: path.join(e2e, '.webui-dist'),
  PENPLOT_LOG_LEVEL: process.env.E2E_LOG_LEVEL ?? 'WARNING',
  PYTHONUNBUFFERED: '1',
}

let child = null
let stopping = false
let starts = 0

function writeState() {
  const st = {
    dataDir,
    port,
    baseURL: `http://${host}:${port}`,
    supervisorPid: process.pid,
    backendPid: child?.pid ?? null,
    starts,
    staticDir: env.PENPLOT_STATIC_DIR,
    python,
  }
  fs.writeFileSync(stateFile + '.tmp', JSON.stringify(st, null, 2))
  fs.renameSync(stateFile + '.tmp', stateFile)
}

function start() {
  starts++
  child = spawn(python, ['-m', 'penplot.web', 'serve'], { cwd: repo, env, stdio: ['ignore', 'inherit', 'inherit'] })
  writeState()
  child.on('exit', (code, sig) => {
    child = null
    writeState()
    if (stopping) return
    console.log(`[e2e] backend exited (code=${code} sig=${sig}); restarting`)
    const again = () => {
      if (stopping) return
      if (fs.existsSync(holdFile)) return void setTimeout(again, 100)
      start()
    }
    setTimeout(again, 300)
  })
}

function shutdown() {
  if (stopping) return
  stopping = true
  const done = () => {
    if (!process.env.E2E_KEEP_DATA) fs.rmSync(dataDir, { recursive: true, force: true })
    else console.log('[e2e] kept data dir', dataDir)
    fs.rmSync(stateFile, { force: true })
    process.exit(0)
  }
  if (!child) return done()
  child.once('exit', done)
  child.kill('SIGTERM')
  setTimeout(() => child?.kill('SIGKILL'), 8000).unref()
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
process.on('SIGHUP', shutdown)

console.log(`[e2e] data dir ${dataDir}`)
start()
