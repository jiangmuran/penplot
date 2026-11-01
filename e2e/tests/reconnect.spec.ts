import { restartBackend, takeBackendDown } from '../helpers/backend'
import { uniq } from '../helpers/env'
import { plotGcode } from '../helpers/gcode'
import { expect, test } from '../helpers/fixtures'

/**
 * Backend restarts. scripts/serve.mjs supervises the backend like systemd (Restart=always); a hold file
 * keeps it down for a deterministic "server offline" window.
 */
test.describe('WebSocket reconnect', () => {
  test('backend down → yellow banner, controls disabled, E-stop kept; back up → recovers by itself', async ({ app, page, machine }) => {
    await app.goto('/machine')
    const main = page.getByRole('main')
    await expect(main.getByRole('button', { name: '落笔', exact: true })).toBeEnabled()

    const down = await takeBackendDown()
    let released = false
    try {
      const banner = page.getByRole('status').filter({ hasText: /连接中断|与设备的连接已断开|无法连接到设备/ })
      await expect(banner).toBeVisible({ timeout: 15_000 })
      if (!app.compact) await expect(app.statusPill()).toHaveAccessibleName(/设备离线/)
      await expect(main.getByRole('button', { name: '落笔', exact: true })).toBeDisabled()
      // E-stop never disappears (it falls back to HTTP retries)
      await expect(app.estop()).toBeVisible()
      await expect(app.estop()).toBeEnabled()

      await down.release()
      released = true
      await expect(banner).toBeHidden({ timeout: 20_000 })
      await app.waitLive()
      await expect(page.getByRole('heading', { name: '页面出错了' })).toHaveCount(0)
      // the snapshot after reconnect is fresh: machine is connected again
      await expect.poll(async () => (await machine.machine()).connected, { timeout: 20_000 }).toBe(true)
      await expect(main.getByRole('button', { name: '落笔', exact: true })).toBeEnabled({ timeout: 20_000 })
    } finally {
      if (!released) await down.release()
    }
  })

  test('restart during a job → job aborted(shutdown), UI reconnects and shows the interruption', async ({ app, page, machine }) => {
    const name = uniq('e2e-restart')
    const fileId = await machine.importGcode(`${name}.gcode`, plotGcode(1500))
    await app.goto('/jobs')
    const job = await machine.createJob(fileId, name, true)
    await expect(page.getByRole('main').getByRole('link', { name })).toBeVisible()
    await expect.poll(async () => (await machine.job(job.id)).acked_line).toBeGreaterThan(20)

    await restartBackend()
    const after = await machine.waitJob(job.id, ['aborted', 'failed'], 30_000)
    expect(['shutdown', 'process_crash']).toContain(after.reason)
    await app.waitLive()
    await expect(page.getByText(`「${name}」被中断`)).toBeVisible({ timeout: 20_000 })
  })

  test('restart from 系统 › 重启服务 reconnects automatically', async ({ app, page, machine }) => {
    const { runState } = await import('../helpers/env')
    const before = runState().starts
    await app.goto('/system')
    await page.getByRole('button', { name: '重启服务…' }).click()
    await page.getByRole('alertdialog', { name: '重启 PenPlot 服务？' }).getByRole('button', { name: '重启', exact: true }).click()
    await expect(page.getByText(/正在重启/).first()).toBeVisible()
    await expect.poll(() => runState().starts, { timeout: 30_000, message: 'a new backend process was started' }).toBeGreaterThan(before)
    await expect(page.getByText(/正在重启/)).toBeHidden({ timeout: 45_000 })
    await app.waitLive()
    await expect(page.getByRole('heading', { name: '页面出错了' })).toHaveCount(0)
    void machine
  })
})
