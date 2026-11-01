import { uniq } from '../helpers/env'
import { plotGcode } from '../helpers/gcode'
import { expect, test } from '../helpers/fixtures'

/**
 * Fault scenarios on FakeGrbl. There is no PENPLOT_FAKE_FAULTS switch in the backend (yet), so faults
 * are provoked through real interfaces: an unsupported G-code word (error:20) and a soft reset during a
 * jog (ALARM:3). USB unplug has no injection hook and stays fixme.
 */
test.describe('faults & recovery guidance', () => {
  test('error:N mid-job → job failed(gcode_error) and the UI offers the recovery wizard', async ({ app, page, machine }) => {
    const name = uniq('e2e-err')
    const fileId = await machine.importGcode(`${name}.gcode`, plotGcode(120, { extra: ['G5 X1'] }))
    await app.goto('/jobs')
    const job = await machine.createJob(fileId, name, true)
    const end = await machine.waitJob(job.id, ['failed'], 30_000)
    expect(end.reason).toBe('gcode_error')
    expect(end.errors[0]).toMatchObject({ cmd: 'G5 X1', reply: 'error:20' })

    const banner = page.getByText(`「${name}」被中断`)
    await expect(banner).toBeVisible()
    await expect(page.getByText(/G 代码错误/).first()).toBeVisible()
    await page.getByRole('button', { name: '恢复向导…' }).click()
    const wizard = page.getByRole('dialog')
    await expect(wizard).toBeVisible()
    // the guidance must talk about lifting the pen and the origin before resuming
    await expect(wizard).toContainText(/抬笔/)
    await expect(wizard).toContainText(/原点|设零/)
    await page.keyboard.press('Escape')
    await expect(wizard).toBeHidden()
  })

  test('ALARM:3 (soft reset while moving) → red banner with hint, unlock clears it, origin flagged lost', async ({ app, page, machine }) => {
    await app.goto('/console')
    // arrange: a slow 50 mm jog (≈5 s with FAKE_TIME_SCALE=0.05) through REST; act: ⌃X in the console while it moves
    await machine.post('/machine/jog', { dx: 50, dy: 0, dz: 0, feed: 30, seq: Date.now() })
    await expect.poll(async () => (await machine.machine()).grbl_state).toBe('Jog')
    await page.getByRole('button', { name: '⌃X 软复位' }).click()
    await app.confirm('软复位')

    const alarm = page.getByRole('status').filter({ hasText: '报警' })
    await expect(alarm).toBeVisible()
    await expect(alarm).toContainText('3')
    await expect(alarm).toContainText(/坐标|设零|复位/)
    const st = await machine.machine()
    expect(st.grbl_state).toMatch(/^Alarm/)
    expect(st.origin_valid).toBe(false)

    await alarm.getByRole('button', { name: '解锁 $X' }).click()
    await expect(alarm).toBeHidden()
    await expect.poll(async () => (await machine.machine()).grbl_state).toBe('Idle')

    // machine page explains how to recover the lost origin
    await app.nav('控制')
    await expect(page.getByText(/原点无效|原点未设/).first()).toBeVisible()
    await expect(page.getByText(/坐标已丢失/).first()).toBeVisible()
  })

  test.fixme('USB unplug mid-job → job failed(serial_lost), disconnected state with reconnect guidance', async () => {
    // Needs a fault hook: FakeGrbl has unplug() but nothing exposes it (no PENPLOT_FAKE_FAULTS env or
    // dev-only endpoint). Expected per 03 §2.5: job → failed(serial_lost), status pill 未连接, origin_valid=false,
    // the jobs page shows the recovery wizard; replug → auto reconnect.
  })

  test.fixme('PENPLOT_FAKE_FAULTS=alarm:N / error:N / unplug at line N', async () => {
    // The task brief mentions PENPLOT_FAKE_FAULTS; penplot/web/config.py does not read it yet. When it lands,
    // drive the three scenarios from env instead of the console tricks above.
  })
})
