import { plotGcode } from '../helpers/gcode'
import { uniq } from '../helpers/env'
import { expect, test } from '../helpers/fixtures'

/** Parse "42% · 剩余 0:12" / "已暂停 · 42%" out of the mini-player text. */
async function miniPercent(text: string | null) {
  const m = /(\d+)%/.exec(text ?? '')
  return m ? Number(m[1]) : -1
}

test.describe('jobs on FakeGrbl', () => {
  test('queued job started from 任务 runs to done; mini-player shows live progress', async ({ app, page, machine }) => {
    const name = uniq('e2e-run')
    const fileId = await machine.importGcode(`${name}.gcode`, plotGcode(450))
    const job = await machine.createJob(fileId, name, false)
    expect(job.status).toBe('queued')

    await app.goto('/jobs')
    await page.getByRole('button', { name: `开始「${name}」` }).click()
    await app.confirm('开始')

    // mini-player is hidden on the jobs page itself (02-ux §2.5): watch it from another page
    await app.nav('字库')
    const mini = app.miniPlayer()
    await expect(mini).toBeVisible()
    await expect(mini).toContainText(name)
    // progress moves: first a value > 0, later a strictly larger one
    let first = -1
    await expect.poll(async () => (first = await miniPercent(await mini.innerText())), { timeout: 20_000 }).toBeGreaterThan(0)
    await expect.poll(async () => miniPercent(await mini.innerText()), { timeout: 20_000 }).toBeGreaterThan(first)
    // the status pill (desktop) mirrors the running state
    if (!app.compact) await expect(app.statusPill()).toHaveAccessibleName(/运行中|运行|%/)

    await expect(mini).toContainText('已完成', { timeout: 30_000 })
    expect((await machine.job(job.id)).status).toBe('done')
    // …and the player collapses again after ~5 s
    await expect(mini).toBeHidden({ timeout: 10_000 })
  })

  test('pause / resume / stop from the 任务 page', async ({ app, page, machine }) => {
    const name = uniq('e2e-pause')
    const fileId = await machine.importGcode(`${name}.gcode`, plotGcode(1500))
    await app.goto('/jobs')
    const job = await machine.createJob(fileId, name, true)
    const main = page.getByRole('main')
    await expect(main.getByRole('link', { name })).toBeVisible()

    await main.getByRole('button', { name: '暂停', exact: true }).click()
    await expect.poll(async () => (await machine.job(job.id)).status, { timeout: 15_000 }).toBe('paused')
    await expect(main.getByRole('button', { name: '继续', exact: true })).toBeVisible()
    const pausedAt = (await machine.job(job.id)).acked_line

    await main.getByRole('button', { name: '继续', exact: true }).click()
    await expect.poll(async () => (await machine.job(job.id)).status).toBe('running')
    await expect.poll(async () => (await machine.job(job.id)).acked_line, { message: 'streaming resumed' }).toBeGreaterThan(pausedAt)

    await main.getByRole('button', { name: '停止…' }).click()
    const dlg = page.getByRole('alertdialog', { name: '停止当前任务？' })
    await expect(dlg).toBeVisible()
    // destructive confirmation: Cancel has default focus (02-ux §2.6)
    await expect(dlg.getByRole('button', { name: '取消' })).toBeFocused()
    await dlg.getByRole('button', { name: '停止', exact: true }).click()
    const end = await machine.waitJob(job.id, ['aborted'])
    expect(end.reason).toBe('user_stop')
    await expect(main.getByRole('button', { name: '暂停', exact: true })).toBeHidden()
  })

  test('pause / resume from the mini-player on another page', async ({ app, machine }) => {
    const name = uniq('e2e-mini')
    const fileId = await machine.importGcode(`${name}.gcode`, plotGcode(1500))
    await app.goto('/machine')
    const job = await machine.createJob(fileId, name, true)
    const mini = app.miniPlayer()
    await expect(mini).toContainText(name)
    await mini.getByRole('button', { name: '暂停' }).click()
    await expect.poll(async () => (await machine.job(job.id)).status, { timeout: 15_000 }).toBe('paused')
    await expect(mini).toContainText('已暂停')
    await mini.getByRole('button', { name: '继续' }).click()
    await expect.poll(async () => (await machine.job(job.id)).status).toBe('running')
    await machine.post(`/jobs/${job.id}/stop`)
    await machine.waitJob(job.id, ['aborted'])
  })

  test('Space toggles pause outside the studio (desktop shortcut)', async ({ app, page, machine, compact }) => {
    test.skip(compact, 'keyboard shortcut')
    const name = uniq('e2e-space')
    const fileId = await machine.importGcode(`${name}.gcode`, plotGcode(1500))
    await app.goto('/jobs')
    const job = await machine.createJob(fileId, name, true)
    await expect(page.getByRole('main').getByRole('link', { name })).toBeVisible()
    await expect.poll(async () => (await machine.job(job.id)).status).toBe('running')
    await page.getByRole('main').click({ position: { x: 5, y: 5 } })
    await page.keyboard.press('Space')
    await expect.poll(async () => (await machine.job(job.id)).status, { timeout: 15_000 }).toBe('paused')
    // the shortcut toggles based on the UI's job state: wait until the UI shows "paused" too
    await expect(page.getByRole('main').getByRole('button', { name: '继续', exact: true })).toBeVisible()
    await page.keyboard.press('Space')
    await expect.poll(async () => (await machine.job(job.id)).status).toBe('running')
    await machine.post(`/jobs/${job.id}/stop`)
    await machine.waitJob(job.id, ['aborted'])
  })

  test('history lists finished jobs; filter, search and detail deep link work', async ({ app, page, machine }) => {
    const name = uniq('e2e-hist')
    const fileId = await machine.importGcode(`${name}.gcode`, plotGcode(20))
    const job = await machine.createJob(fileId, name, true)
    await machine.waitJob(job.id, ['done'])

    await app.goto('/jobs')
    if (app.compact) {
      const view = page.getByRole('radiogroup', { name: '视图' })
      if (await view.count()) await view.getByRole('radio', { name: '历史' }).click()
    }
    const hist = page.getByRole('region', { name: '历史' })
    await expect(hist).toBeVisible()
    await hist.getByRole('searchbox', { name: '搜索任务' }).fill(name)
    await expect(hist.getByText(name).first()).toBeVisible()
    await hist.getByRole('radio', { name: '失败' }).click()
    await expect(hist.getByText(name)).toHaveCount(0)
    await hist.getByRole('radio', { name: '完成' }).click()
    await expect(hist.getByText(name).first()).toBeVisible()

    await page.goto(`/jobs/${job.id}`)
    const detail = page.getByRole('dialog')
    await expect(detail).toBeVisible()
    await expect(detail).toContainText(name)
  })
})
