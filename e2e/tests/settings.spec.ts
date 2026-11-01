import { uniq } from '../helpers/env'
import { expect, test } from '../helpers/fixtures'

interface Profile {
  id: string
  is_active: boolean
  doc: { settings: { feedRate: number } }
}

test.describe('settings', () => {
  test('profile edit autosaves to the backend and survives a reload', async ({ app, page, api }) => {
    const profiles = await api.get<Profile[]>('/profiles')
    const active = profiles.find((p) => p.is_active) ?? profiles[0]
    const before = (await api.get<Profile>(`/profiles/${active.id}`)).doc.settings.feedRate
    const target = before === 1800 ? 1700 : 1800
    try {
      await app.goto('/settings/machine')
      const feed = page.getByRole('spinbutton', { name: '书写速度' })
      await expect(feed).toHaveValue(String(before))
      await feed.fill(String(target))
      await feed.press('Tab')
      await expect(page.getByRole('status').filter({ hasText: '已保存' }).first()).toBeVisible()
      await expect.poll(async () => (await api.get<Profile>(`/profiles/${active.id}`)).doc.settings.feedRate).toBe(target)
      await page.reload()
      await app.waitLive()
      await expect(page.getByRole('spinbutton', { name: '书写速度' })).toHaveValue(String(target))
    } finally {
      await api.patch(`/profiles/${active.id}`, { doc: { settings: { feedRate: before } } })
    }
  })

  test('custom paper preset: create 207×294, listed, then delete', async ({ app, page, api }) => {
    const name = uniq('E2E纸')
    await app.goto('/settings/papers')
    await page.getByRole('button', { name: '新建纸张' }).first().click()
    const dlg = page.getByRole('dialog', { name: '新建纸张' })
    await dlg.getByLabel('名称').fill(name)
    await dlg.getByLabel('宽度', { exact: true }).fill('207')
    await dlg.getByLabel('高度', { exact: true }).fill('294')
    await dlg.getByRole('button', { name: '添加' }).click()
    await expect(dlg).toBeHidden()
    await expect(page.getByText(name).first()).toBeVisible()
    await expect(page.getByText(/207 × 294 mm/).first()).toBeVisible()
    const papers = await api.get<{ id: string; name: string; width_mm: number; height_mm: number; builtin: boolean }[]>('/papers')
    const mine = papers.find((p) => p.name === name)
    expect(mine).toMatchObject({ width_mm: 207, height_mm: 294, builtin: false })

    // deletion is undoable (toast with 撤销) rather than confirmed (02-ux §2.6)
    await page.getByRole('button', { name: `删除「${name}」` }).click()
    await expect(page.getByText(`已删除「${name}」`).first()).toBeVisible()
    await expect(page.getByRole('main').getByText(name)).toHaveCount(0)
    expect((await api.get<{ name: string }[]>('/papers')).some((p) => p.name === name)).toBe(false)
  })

  test('appearance: dark theme and accent apply immediately and persist', async ({ app, page }) => {
    await app.goto('/settings/appearance')
    await page.getByRole('radio', { name: '深色' }).click()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    await page.getByRole('radio', { name: '紫色' }).click()
    await expect(page.locator('html')).toHaveAttribute('data-accent', /purple/)
    await page.reload()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    await page.getByRole('radio', { name: '跟随系统' }).click()
    await page.getByRole('radio', { name: '蓝色' }).click()
    await expect(page.locator('html')).not.toHaveAttribute('data-theme', 'dark')
  })
})
