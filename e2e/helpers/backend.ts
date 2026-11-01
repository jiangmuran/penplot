import fs from 'node:fs'
import { expect, request } from '@playwright/test'
import { BASE_URL, HOLD_FILE, runState } from './env'

export async function healthy(base = BASE_URL) {
  const ctx = await request.newContext({ baseURL: base })
  try {
    const r = await ctx.get('/api/v1/system/health', { timeout: 2000 })
    return r.ok()
  } catch {
    return false
  } finally {
    await ctx.dispose()
  }
}

export async function waitHealthy(timeout = 30_000, base = BASE_URL) {
  await expect.poll(() => healthy(base), { timeout, intervals: [100, 250, 500] }).toBe(true)
}

/**
 * Stops the backend process and keeps it down until the returned `release()` is called
 * (the supervisor in scripts/serve.mjs respawns it once the hold file is gone).
 */
export async function takeBackendDown(): Promise<{ release: () => Promise<void> }> {
  const st = runState()
  fs.writeFileSync(HOLD_FILE, String(Date.now()))
  if (st.backendPid) process.kill(st.backendPid, 'SIGTERM')
  await expect.poll(() => healthy(), { timeout: 20_000 }).toBe(false)
  return {
    release: async () => {
      fs.rmSync(HOLD_FILE, { force: true })
      await waitHealthy()
    },
  }
}

/** Restart = SIGTERM, wait until a *new* process answers. */
export async function restartBackend() {
  const before = runState().starts
  const st = runState()
  if (st.backendPid) process.kill(st.backendPid, 'SIGTERM')
  await expect.poll(() => runState().starts, { timeout: 20_000 }).toBeGreaterThan(before)
  await waitHealthy()
}

/** A currently free TCP port on 127.0.0.1 (for extra, test-owned backends). */
export async function freePort(): Promise<number> {
  const net = await import('node:net')
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const a = srv.address()
      const port = typeof a === 'object' && a ? a.port : 0
      srv.close(() => resolve(port))
    })
  })
}
