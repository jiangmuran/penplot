import { uniq } from '../helpers/env'
import { plotGcode } from '../helpers/gcode'
import { expect, test } from '../helpers/fixtures'

test.describe('e-stop', () => {
  test('toolbar E-stop while running aborts the job at once and offers unlock', async ({ app, page, machine }) => {
    const name = uniq('e2e-estop')
    const fileId = await machine.importGcode(`${name}.gcode`, plotGcode(1500))
    await app.goto('/fonts')
    const job = await machine.createJob(fileId, name, true)
    await expect(app.miniPlayer()).toContainText(name)
    await expect.poll(async () => (await machine.job(job.id)).acked_line).toBeGreaterThan(10)

    // single tap, no confirmation (02-ux §2.4)
    await app.estop().click()
    const card = page.getByRole('alertdialog', { name: '已急停，机器需复位' })
    await expect(card).toBeVisible()
    const end = await machine.waitJob(job.id, ['aborted'], 15_000)
    expect(end.reason).toBe('estop')

    // recovery: 「解锁并抬笔」(origin kept) or 「解锁」(origin lost)
    await card.getByRole('button', { name: /^解锁/ }).click()
    await expect(card).toBeHidden()
    await expect.poll(async () => (await machine.machine()).grbl_state).toBe('Idle')
    await expect(page.getByRole('status').filter({ hasText: '报警' })).toHaveCount(0)
  })

  test('Mod+. triggers E-stop even while typing in a field', async ({ app, page, machine, compact }) => {
    test.skip(compact, 'keyboard shortcut')
    const name = uniq('e2e-estop-key')
    const fileId = await machine.importGcode(`${name}.gcode`, plotGcode(1500))
    await app.goto('/fonts')
    const job = await machine.createJob(fileId, name, true)
    await expect(app.miniPlayer()).toContainText(name)
    await page.getByRole('searchbox', { name: '搜索字体' }).click()
    await page.keyboard.type('abc')
    await page.keyboard.press('ControlOrMeta+Period')
    await expect(page.getByRole('alertdialog', { name: '已急停，机器需复位' })).toBeVisible()
    expect((await machine.waitJob(job.id, ['aborted'], 15_000)).reason).toBe('estop')
    await page.getByRole('alertdialog', { name: '已急停，机器需复位' }).getByRole('button', { name: '关闭', exact: true }).first().click()
  })

  test('E-stop stays on top of an open dialog and still stops a running job', async ({ app, page, machine, compact }) => {
    test.skip(compact, 'uses the desktop paper dialog')
    const name = uniq('e2e-estop-dlg')
    const fileId = await machine.importGcode(`${name}.gcode`, plotGcode(1500))
    await app.goto('/settings/papers')
    const job = await machine.createJob(fileId, name, true)
    await page.getByRole('button', { name: '新建纸张' }).first().click()
    await expect(page.getByRole('dialog', { name: '新建纸张' })).toBeVisible()
    // located via its portal (not by role: see the a11y test below); a real click hit-tests the top element
    await page.locator('[data-estop-layer] button[aria-label="急停"]').click()
    expect((await machine.waitJob(job.id, ['aborted'], 15_000)).reason).toBe('estop')
  })

  test('E-stop remains reachable for assistive tech while a dialog is open', async ({ app, page, compact }) => {
    test.skip(compact, 'uses the desktop paper dialog')
    await app.goto('/settings/papers')
    await page.getByRole('button', { name: '新建纸张' }).first().click()
    await expect(page.getByRole('dialog', { name: '新建纸张' })).toBeVisible()
    await expect(page.getByRole('button', { name: '急停', exact: true })).toBeVisible({ timeout: 3000 })
  })
})
