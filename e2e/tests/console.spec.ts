import { expect, test } from '../helpers/fixtures'

test.describe('console', () => {
  test('raw command gets a reply; firmware errors are shown and explained; ↑ recalls history', async ({ app, page, machine }) => {
    void machine
    await app.goto('/console')
    const input = page.getByRole('textbox', { name: '命令' })
    await input.fill('$I')
    await input.press('Enter')
    await expect(page.getByText(/\[VER:1\.1f/).first()).toBeVisible()
    await expect(input).toHaveValue('')

    await input.fill('G5 X1')
    await page.getByRole('button', { name: '发送', exact: true }).click()
    await expect(page.getByText(/error:20/).first()).toBeVisible()

    await input.press('ArrowUp')
    await expect(input).toHaveValue('G5 X1')
    await input.press('ArrowUp')
    await expect(input).toHaveValue('$I')
  })

  test('serial log shows TX/RX lines and can be filtered', async ({ app, page, machine }) => {
    void machine
    await app.goto('/console')
    const input = page.getByRole('textbox', { name: '命令' })
    await input.fill('$G')
    await input.press('Enter')
    const log = page.getByRole('log', { name: '串口日志' })
    await expect(log.getByText('$G').first()).toBeVisible()
    await expect(log.getByText(/\[GC:/).first()).toBeVisible()
    await page.getByRole('searchbox', { name: '过滤日志' }).fill('GC:')
    await expect(log.getByText(/\[GC:/).first()).toBeVisible()
  })

  test('non-realtime commands are refused while a job runs', async ({ app, page, machine }) => {
    const { plotGcode } = await import('../helpers/gcode')
    const fileId = await machine.importGcode('console-busy.gcode', plotGcode(1500))
    await app.goto('/console')
    const job = await machine.createJob(fileId, 'console-busy', true)
    const input = page.getByRole('textbox', { name: '命令' })
    await expect(page.getByText(/任务进行中/).first()).toBeVisible()
    if (await input.isEnabled()) {
      await input.fill('G0 X1')
      await expect(page.getByRole('button', { name: '发送', exact: true })).toBeDisabled()
    }
    await machine.post(`/jobs/${job.id}/stop`)
    await machine.waitJob(job.id, ['aborted'])
  })

  test('a $J= jog line is accepted as a raw command', async ({ app, page, machine }) => {
    await app.goto('/console')
    const input = page.getByRole('textbox', { name: '命令' })
    await input.fill('$J=G91 X1 F1000')
    await input.press('Enter')
    await expect.poll(async () => (await machine.machine()).wpos?.[0], { timeout: 5000 }).toBe(1)
  })
})
