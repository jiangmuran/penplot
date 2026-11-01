import { Api } from '../helpers/api'
import { uniq } from '../helpers/env'
import { expect, test } from '../helpers/fixtures'

test.describe('API tokens', () => {
  test('create a read-only token in the UI, call REST with Bearer, then revoke it', async ({ app, page }) => {
    const name = uniq('e2e-token')
    await app.goto('/settings/account')
    await page.getByRole('button', { name: '新建令牌' }).click()
    const dlg = page.getByRole('dialog', { name: '新建 API 令牌' })
    await dlg.getByLabel('名称').fill(name)
    await dlg.getByRole('button', { name: '创建' }).click()
    const created = page.getByRole('dialog', { name: '令牌已创建' })
    await expect(created).toBeVisible()
    const token = await created.getByRole('textbox', { name: 'API 令牌' }).inputValue()
    expect(token).toMatch(/^ppt_[A-Za-z0-9]+_\S+$/)
    await created.getByRole('button', { name: '完成' }).click()

    const bearer = await Api.bearer(token)
    try {
      const st = await bearer.get<{ connected: boolean }>('/machine/status')
      expect(typeof st.connected).toBe('boolean')
      // read scope only: control calls are refused, no CSRF header needed for Bearer
      const denied = await bearer.raw('POST', '/machine/pen', { state: 'up' })
      expect(denied.status()).toBe(403)

      await expect(page.getByText(name).first()).toBeVisible()
      const row = page.getByText(name).first().locator('xpath=ancestor::div[contains(@class,"min-h-14")][1]')
      await row.getByRole('button', { name: '吊销' }).click()
      await app.confirm('吊销')
      await expect(page.getByText(name)).toHaveCount(0)
      expect((await bearer.raw('GET', '/machine/status')).status()).toBe(401)
    } finally {
      await bearer.dispose()
    }
  })
})
