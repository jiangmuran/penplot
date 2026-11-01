import { Api } from '../helpers/api'
import { PASSWORD, uniq } from '../helpers/env'
import { plotGcode } from '../helpers/gcode'
import { expect, knownBug, test } from '../helpers/fixtures'

const dro = (page: import('@playwright/test').Page, axis: 'X' | 'Y' | 'Z') => page.getByLabel(new RegExp(`^${axis} -?[\\d.]+ 毫米$`)).first()

test.describe('machine control', () => {
  test('jog XY moves the DRO; set zero resets it', async ({ app, page, machine }) => {
    await app.goto('/machine')
    const main = page.getByRole('main')
    await expect(dro(page, 'X')).toHaveAccessibleName(/^X 0(\.0+)? 毫米$/)
    await main.getByRole('radio', { name: '10', exact: true }).click()
    await main.getByRole('button', { name: 'X+ 10 mm' }).click()
    await expect(dro(page, 'X')).toHaveAccessibleName(/^X 10(\.0+)? 毫米$/)
    await main.getByRole('button', { name: 'Y− 10 mm' }).click()
    await expect(dro(page, 'Y')).toHaveAccessibleName(/^Y -10(\.0+)? 毫米$/)
    expect((await machine.machine()).wpos?.slice(0, 2)).toEqual([10, -10])

    await main.getByRole('button', { name: '设为原点', exact: true }).click()
    await app.confirm('设为原点')
    await expect(dro(page, 'X')).toHaveAccessibleName(/^X 0(\.0+)? 毫米$/)
    await expect(dro(page, 'Y')).toHaveAccessibleName(/^Y 0(\.0+)? 毫米$/)
  })

  test('pen down / up updates the pen badge', async ({ app, page, machine }) => {
    await app.goto('/machine')
    const main = page.getByRole('main')
    await main.getByRole('button', { name: '落笔', exact: true }).click()
    await expect(main.getByText('笔 落下')).toBeVisible()
    expect((await machine.machine()).pen).toBe('down')
    await main.getByRole('button', { name: '抬笔', exact: true }).click()
    await expect(main.getByText('笔 抬起')).toBeVisible()
    expect((await machine.machine()).pen).toBe('up')
  })

  test('manual controls are disabled while a job runs and explain why', async ({ app, page, machine }) => {
    const name = uniq('e2e-busy')
    const fileId = await machine.importGcode(`${name}.gcode`, plotGcode(1500))
    await app.goto('/machine')
    const job = await machine.createJob(fileId, name, true)
    const main = page.getByRole('main')
    await expect(main.getByRole('button', { name: '落笔', exact: true })).toBeDisabled()
    // the jog pad collapses (or is disabled) and says why
    await expect(page.getByText(/任务进行中，暂停后可点动/).first()).toBeVisible()
    const jog = main.getByRole('button', { name: 'X+ 1 mm' })
    if (await jog.count()) await expect(jog).toBeDisabled()
    // the backend agrees (409 machine_busy)
    const r = await machine.raw('POST', '/machine/jog', { dx: 1, dy: 0, dz: 0, seq: 1 })
    expect(r.status()).toBe(409)
    await machine.post(`/jobs/${job.id}/stop`)
    await machine.waitJob(job.id, ['aborted'])
    await expect(main.getByRole('button', { name: 'X+ 1 mm' })).toBeEnabled()
  })

  test.describe('jog dedupe', () => {
    test.use({ jogSeqShim: false })
    test('jog still moves the machine after a page reload (per-client seq)', async ({ app, page, machine }) => {
      knownBug('F4', 'backend dedupes jog seq globally; a reloaded page restarts at seq 1 and its jogs are acked but dropped')
      await app.goto('/machine')
      const main = page.getByRole('main')
      await main.getByRole('button', { name: 'X+ 1 mm' }).click()
      await expect.poll(async () => (await machine.machine()).wpos?.[0]).toBe(1)
      await page.reload()
      await app.waitLive()
      await main.getByRole('button', { name: 'X+ 1 mm' }).click()
      await expect.poll(async () => (await machine.machine()).wpos?.[0], { timeout: 5000 }).toBe(2)
    })
  })

  test('admin keeps control after its own first manual action (lease held by the same user)', async ({ app, page, machine }) => {
    // regression test for F3 (fixed): the UI used to treat its own lease as foreign and lock itself out
    await machine.del('/machine/lease').catch(() => null)
    await app.goto('/machine')
    const main = page.getByRole('main')
    await main.getByRole('button', { name: '抬笔', exact: true }).click()
    await expect.poll(async () => (await machine.get<{ held: boolean }>('/machine/lease')).held).toBe(true)
    await expect(page.getByText('你的手动控制已停用')).toHaveCount(0)
    await expect(main.getByRole('button', { name: '落笔', exact: true })).toBeEnabled()
    await main.getByRole('button', { name: '落笔', exact: true }).click()
    await expect(main.getByText('笔 落下')).toBeVisible()
  })

  test.describe('control lease (operator session)', () => {
    test.use({ storageState: { cookies: [], origins: [] } })

    test('operator is blocked while the admin holds control, E-stop stays; released → usable and auto-acquired', async ({ app, page, machine }) => {
      const r = await machine.raw('POST', '/users', { username: 'e2e_op', password: PASSWORD, role: 'operator', display_name: '操作员E2E' })
      test.fixme(r.status() === 404 || r.status() === 501, 'multi-user / lease backend not available')
      expect([200, 201, 409]).toContain(r.status())
      try {
        await machine.post('/machine/lease', { force: true })
        // log in through the UI as the operator (username field)
        await page.goto('/machine')
        await expect(page).toHaveURL(/\/login/)
        await page.getByLabel('用户名').fill('e2e_op')
        await page.getByLabel('密码', { exact: true }).fill(PASSWORD)
        await page.getByRole('button', { name: '登录', exact: true }).click()
        await expect(page).toHaveURL(/\/machine$/)
        await app.waitLive()

        const main = page.getByRole('main')
        await expect(page.getByText(/正在控制/).first()).toBeVisible()
        await expect(main.getByRole('button', { name: 'X+ 1 mm' })).toBeDisabled()
        await expect(main.getByRole('button', { name: '落笔', exact: true })).toBeDisabled()
        await expect(app.estop()).toBeEnabled()
        await expect(page.getByRole('button', { name: '强制接管' })).toHaveCount(0) // admin-only
        // the backend agrees
        const op = await Api.session(PASSWORD, undefined, 'e2e_op')
        try {
          expect((await op.raw('POST', '/machine/pen', { state: 'up' })).status()).toBe(409)
        } finally {
          await op.dispose()
        }

        await machine.del('/machine/lease')
        await expect(main.getByRole('button', { name: '落笔', exact: true })).toBeEnabled()
        await main.getByRole('button', { name: '抬笔', exact: true }).click()
        await expect
          .poll(async () => (await machine.get<{ holder: { username: string } | null }>('/machine/lease')).holder?.username)
          .toBe('e2e_op')
        // admins may act regardless of the lease
        expect((await machine.raw('POST', '/machine/pen', { state: 'up' })).status()).toBe(200)
      } finally {
        await machine.del('/machine/lease').catch(() => null)
      }
    })
  })
})
