import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { freePort, waitHealthy } from '../helpers/backend'
import { PYTHON, REPO_DIR, STATIC_DIR } from '../helpers/env'
import { expect, test } from '../helpers/fixtures'

/**
 * Production-like first run: a separate backend WITHOUT PENPLOT_DEV, so the 8-digit setup code is
 * required. The test reads it from <data dir>/setup-code like an operator would over ssh.
 */
let PORT = 0
let BASE = ''
let proc: ChildProcess | null = null
let dataDir = ''

test.describe.configure({ mode: 'serial' })
test.use({ storageState: { cookies: [], origins: [] } })

test.beforeAll(async () => {
  PORT = await freePort()
  BASE = `http://127.0.0.1:${PORT}`
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'penplot-e2e-setup-'))
  proc = spawn(PYTHON, ['-m', 'penplot.web', 'serve'], {
    cwd: REPO_DIR,
    stdio: 'ignore',
    env: {
      ...process.env,
      PENPLOT_DEV: '0',
      PENPLOT_DATA_DIR: dataDir,
      PENPLOT_SERIAL_PORT: 'fake',
      PENPLOT_FAKE_TIME_SCALE: '0.05',
      PENPLOT_PORT: String(PORT),
      PENPLOT_HOST: '127.0.0.1',
      PENPLOT_STATIC_DIR: STATIC_DIR,
      PENPLOT_LOG_LEVEL: 'WARNING',
    },
  })
  await waitHealthy(30_000, BASE)
})

test.afterAll(async () => {
  if (proc && proc.exitCode == null) {
    const exited = new Promise((r) => proc!.once('exit', r))
    proc.kill('SIGTERM')
    await Promise.race([exited, new Promise((r) => setTimeout(r, 8000))])
    if (proc.exitCode == null) proc.kill('SIGKILL')
  }
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true })
})

const PW = 'setup-code-Passw0rd'

test('setup requires the code from the data dir; wrong code is rejected', async ({ page, guard }) => {
  guard.allow(/HTTP 403 POST \/api\/v1\/auth\/setup/)
  const codeFile = path.join(dataDir, 'setup-code')
  await expect.poll(() => fs.existsSync(codeFile), { message: 'backend writes setup-code on first boot' }).toBe(true)
  const code = fs.readFileSync(codeFile, 'utf8').trim()
  expect(code).toMatch(/^\d{8}$/)
  expect(fs.statSync(codeFile).mode & 0o077, 'setup-code is 0600').toBe(0)

  await page.goto(BASE + '/')
  await expect(page).toHaveURL(/\/setup$/)
  const codeInput = page.getByLabel('设置码')
  await expect(codeInput).toBeVisible()

  const wrong = code === '00000000' ? '11111111' : '00000000'
  await codeInput.fill(wrong)
  await page.getByLabel('新密码').fill(PW)
  await page.getByLabel('确认密码').fill(PW)
  await page.getByRole('button', { name: '创建并登录' }).click()
  await expect(page.getByText('设置码不正确')).toBeVisible()
  await expect(page).toHaveURL(/\/setup$/)

  await codeInput.fill(code)
  await page.getByRole('button', { name: '创建并登录' }).click()
  await expect(page).toHaveURL(/\/(studio|welcome)/)
  await expect(page.getByRole('button', { name: /^机器状态：/ })).toBeVisible()
  expect(fs.existsSync(codeFile), 'setup-code is deleted after setup').toBe(false)

  // setup is one-shot
  const again = await page.request.post(BASE + '/api/v1/auth/setup', { headers: { 'X-Penplot': '1', Origin: BASE }, data: { setup_code: code, password: PW } })
  expect(again.status()).toBe(409)
})

test('login with wrong then right password, logout returns to /login', async ({ page, guard, compact }) => {
  guard.allow(/HTTP 401 /)
  await page.goto(BASE + '/jobs')
  await expect(page).toHaveURL(/\/login\?next=%2Fjobs/)
  const pw = page.getByLabel('密码', { exact: true })
  await pw.fill('definitely-wrong')
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await expect(page.getByText('密码不正确')).toBeVisible()
  await expect(pw).toHaveValue('')

  await pw.fill(PW)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await expect(page).toHaveURL(/\/jobs$/)

  if (compact) {
    await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '更多' }).click()
    await page.getByRole('dialog', { name: '更多' }).getByRole('button', { name: '退出登录' }).click()
  } else {
    await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: /^(admin|管理员)/ }).click()
    await page.getByRole('menuitem', { name: '退出登录' }).click()
  }
  await expect(page).toHaveURL(/\/login/)
  const st = await (await page.request.get(BASE + '/api/v1/auth/state')).json()
  expect(st.authenticated).toBe(false)
  // the session cookie no longer opens app routes
  await page.goto(BASE + '/machine')
  await expect(page).toHaveURL(/\/login/)
})
