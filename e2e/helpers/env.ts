import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const E2E_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const REPO_DIR = path.resolve(E2E_DIR, '..')
export const RUN_DIR = path.join(E2E_DIR, '.run')
export const STATE_FILE = path.join(RUN_DIR, 'state.json')
export const HOLD_FILE = path.join(RUN_DIR, 'hold')
export const STORAGE_STATE = path.join(E2E_DIR, '.auth', 'admin.json')
export const STATIC_DIR = path.join(E2E_DIR, '.webui-dist')
export const PORT = Number(process.env.E2E_PORT ?? 8093)
export const BASE_URL = `http://127.0.0.1:${PORT}`
export const API = '/api/v1'
/** Admin password used for the main backend (set by tests/auth.setup.ts through the UI). */
export const PASSWORD = 'e2e-Passw0rd-123'
export const PYTHON = process.env.E2E_PYTHON ?? path.join(REPO_DIR, '.venv/bin/python')

export interface RunState {
  dataDir: string
  port: number
  baseURL: string
  supervisorPid: number
  backendPid: number | null
  starts: number
  staticDir: string
  python: string
}

export function runState(): RunState {
  return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as RunState
}

/** Unique, readable names so runs and projects don't collide in the shared backend. */
let n = 0
export function uniq(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}${(n++).toString(36)}`
}
