import fs from 'node:fs'
import path from 'node:path'
import { test as setup, expect } from '@playwright/test'
import type { Page } from '@playwright/test'
import { PASSWORD, STORAGE_STATE } from '../helpers/env'

/**
 * First login opens the onboarding wizard (/welcome) once per browser session; dismiss it for good
 * («以后再说» is persisted in /settings) so the rest of the suite starts from the normal shell.
 */
async function dismissOnboarding(page: Page) {
  await expect(page).toHaveURL(/\/(studio|welcome)/)
  if (/\/welcome/.test(page.url())) {
    await expect(page.getByRole('button', { name: '开始设置' })).toBeVisible()
    await page.getByRole('button', { name: '以后再说' }).click()
  }
  await expect(page).toHaveURL(/\/studio/)
  await expect(page.getByRole('button', { name: /^机器状态：/ })).toBeVisible()
  await expect
    .poll(async () => (await (await page.request.get('/api/v1/settings')).json())?.ui?.onboarding?.dismissed ?? null, {
      message: 'onboarding dismissal persisted server-side',
    })
    .toBe(true)
}

/**
 * First-run setup through the UI on the main (PENPLOT_DEV=1) backend. Dev mode needs no setup code
 * (04 §3), so the code field must be absent here; the setup-code flow is covered by
 * setup-code.spec.ts against a separate non-dev backend. Saves the admin session for all projects.
 */
setup('first-run setup creates the admin and logs in', async ({ page }) => {
  const state = await (await page.request.get('/api/v1/auth/state')).json()
  if (!state.setup_required && process.env.E2E_REUSE === '1') {
    // reused dev server (E2E_REUSE=1): admin exists already, just log in through the UI
    await page.goto('/login')
    await page.getByLabel('密码', { exact: true }).fill(PASSWORD)
    await page.getByRole('button', { name: '登录', exact: true }).click()
    await dismissOnboarding(page)
    fs.mkdirSync(path.dirname(STORAGE_STATE), { recursive: true })
    await page.context().storageState({ path: STORAGE_STATE })
    return
  }
  expect(state.setup_required, 'fresh temp data dir has no admin').toBe(true)
  expect(state.setup_code_required).toBe(false)

  // any app route redirects to /setup while no admin exists
  await page.goto('/machine')
  await expect(page).toHaveURL(/\/setup$/)
  await expect(page.getByRole('heading', { name: '欢迎使用 PenPlot' })).toBeVisible()
  await expect(page.getByLabel('设置码')).toHaveCount(0)

  const submit = page.getByRole('button', { name: '创建并登录' })
  await page.getByLabel('新密码').fill('short')
  await page.getByLabel('确认密码').fill('short')
  await expect(page.getByText('密码至少 10 个字符')).toBeVisible()
  await expect(submit).toBeDisabled()

  await page.getByLabel('新密码').fill(PASSWORD)
  await page.getByLabel('确认密码').fill(PASSWORD + 'x')
  await expect(page.getByText('两次输入的密码不一致')).toBeVisible()
  await expect(submit).toBeDisabled()

  await page.getByLabel('确认密码').fill(PASSWORD)
  await submit.click()
  await dismissOnboarding(page)

  const after = await (await page.request.get('/api/v1/auth/state')).json()
  expect(after).toMatchObject({ setup_required: false, authenticated: true })

  fs.mkdirSync(path.dirname(STORAGE_STATE), { recursive: true })
  await page.context().storageState({ path: STORAGE_STATE })
})
