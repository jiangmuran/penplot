import { expect, test } from '../helpers/fixtures'

test.describe('fonts', () => {
  test('search filters the font list', async ({ app, page }) => {
    await app.goto('/fonts')
    const list = page.getByRole('list', { name: '字体列表' })
    await expect(list.getByRole('listitem').first()).toBeVisible()
    const total = await list.getByRole('listitem').count()
    expect(total).toBeGreaterThan(3)
    await page.getByRole('searchbox', { name: '搜索字体' }).fill('blood8')
    await expect.poll(() => list.getByRole('listitem').count()).toBeLessThan(total)
    const names = await list.getByRole('listitem').allInnerTexts()
    expect(names.length).toBeGreaterThan(0)
    for (const n of names) expect(n.toLowerCase()).toContain('blood8')
    await page.getByRole('searchbox', { name: '搜索字体' }).fill('no-such-font-xyz')
    await expect(list.getByRole('listitem')).toHaveCount(0)
  })

  test('coverage check ranks fonts by missing glyphs and flags gaps', async ({ app, page }) => {
    await app.goto('/fonts')
    const cover = page.getByRole('textbox', { name: /检查文字覆盖/ })
    await cover.fill('龘靐齉')
    await expect(page.getByText(/按缺字数排序/).first()).toBeVisible()
    await expect(page.getByText(/缺 \d+ 字/).first()).toBeVisible()
    await cover.fill('永')
    await expect(page.getByText('全覆盖').first()).toBeVisible()
    // ranking: the first entry has no more missing glyphs than the last
    const list = page.getByRole('list', { name: '字体列表' })
    const first = await list.getByRole('listitem').first().innerText()
    expect(first).not.toMatch(/缺 \d+ 字/)
  })

  test('selecting a font shows details, sample and coverage', async ({ app, page, compact }) => {
    await app.goto('/fonts')
    await page.getByRole('searchbox', { name: '搜索字体' }).fill('penplot-sans')
    const list = page.getByRole('list', { name: '字体列表' })
    await list.getByRole('button', { name: /penplot-sans/ }).first().click()
    // regular: side-by-side detail region; compact: the detail is pushed as its own screen
    const detail = compact ? page.getByRole('main') : page.getByRole('region', { name: '字体详情' })
    await expect(detail.getByRole('heading', { name: 'penplot-sans', level: 2 })).toBeVisible()
    await expect(detail.getByRole('img', { name: /样张/ })).toBeVisible()
    await detail.getByRole('textbox', { name: '测试文字' }).fill('ABC 123')
    await expect(detail.getByRole('img', { name: /ABC 123/ })).toBeVisible()
    await expect(detail.getByRole('heading', { name: '覆盖' })).toBeVisible()
  })
})
