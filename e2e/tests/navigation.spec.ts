import { expect, test } from '../helpers/fixtures'

/** Every route of 02-ux §1, reached through the real navigation UI (sidebar / tab bar / 更多). */
/** Same route or a sub-route (e.g. /studio → /studio/<last project>). */
const onRoute = (path: string) => (u: URL) => u.pathname === path || u.pathname.startsWith(path + '/')

const ROUTES = [
  // the studio's title is the open project's name
  { label: '创作台', path: '/studio', title: null },
  { label: '项目与模板', path: '/projects', title: '项目与模板' },
  { label: '字库', path: '/fonts', title: '字库' },
  { label: '控制', path: '/machine', title: '控制' },
  { label: '任务', path: '/jobs', title: '任务' },
  { label: '调试', path: '/console', title: '调试' },
  { label: '设置', path: '/settings/general', title: '设置' },
  { label: '系统', path: '/system', title: '系统' },
]

test.describe('navigation', () => {
  for (const r of ROUTES) {
    test(`${r.label} (${r.path}) via navigation UI and deep link renders without errors`, async ({ app, page, guard }) => {
      guard.strict4xx()
      await app.goto(r.path === '/studio' ? '/jobs' : '/studio')
      await app.nav(r.label)
      await expect(page).toHaveURL(onRoute(r.path))
      const check = async () => {
        await expect(page.getByRole('heading', r.title ? { level: 1, name: r.title } : { level: 1 }).first()).toBeVisible()
        await expect(page.getByRole('heading', { name: '页面出错了' })).toHaveCount(0)
        await expect(page.getByRole('heading', { name: '页面不存在' })).toHaveCount(0)
        // E-stop is on every page (02-ux §2.4)
        await expect(app.estop()).toBeVisible()
      }
      await check()
      // deep link / reload goes through the SPA fallback
      await page.reload()
      await app.waitLive()
      await expect(page).toHaveURL(onRoute(r.path))
      await check()
    })
  }

  test('any other sidebar route (new features) renders without errors', async ({ app, page, guard, compact }) => {
    test.skip(compact, 'enumerates the desktop sidebar')
    guard.strict4xx()
    await app.goto('/studio')
    const known = new Set(ROUTES.map((r) => r.path))
    const links = page.getByRole('navigation', { name: '主导航' }).getByRole('link')
    const hrefs = (await links.evaluateAll((els) => els.map((e) => (e as HTMLAnchorElement).getAttribute('href') ?? '')))
      .filter((h) => h.startsWith('/') && !h.startsWith('/api/') && !known.has(h))
    test.info().annotations.push({ type: 'extra-routes', description: hrefs.join(', ') || '(none)' })
    for (const h of hrefs) {
      await test.step(h, async () => {
        await app.goto(h)
        await expect(page.getByRole('heading', { name: '页面出错了' })).toHaveCount(0)
        await expect(page.getByRole('heading', { name: '页面不存在' })).toHaveCount(0)
        await expect(app.estop()).toBeVisible()
      })
    }
  })

  test('each page has exactly one main landmark', async ({ app, page, compact }) => {
    test.skip(compact, 'checked once')
    for (const p of ['/studio', '/jobs', '/machine', '/help']) {
      await test.step(p, async () => {
        await app.goto(p)
        await expect(page.getByRole('main')).toHaveCount(1)
      })
    }
  })

  test('settings sections deep-link without errors', async ({ app, page, guard }) => {
    guard.strict4xx()
    for (const s of ['appearance', 'machine', 'papers', 'account', 'preferences']) {
      await test.step(s, async () => {
        await app.goto(`/settings/${s}`)
        await expect(page).toHaveURL((u) => u.pathname === `/settings/${s}`)
        await expect(page.getByRole('heading', { name: '页面出错了' })).toHaveCount(0)
      })
    }
  })

  test('root and legacy CLI paths redirect to the studio; unknown paths show 404', async ({ app, page }) => {
    for (const p of ['/', '/write', '/image']) {
      await app.goto(p)
      await expect(page).toHaveURL(onRoute('/studio'))
    }
    await app.goto('/no-such-page')
    await expect(page.getByRole('heading', { name: '页面不存在' })).toBeVisible()
  })

  test('desktop: sidebar toggles and Mod+digit shortcuts navigate', async ({ app, page, compact }) => {
    test.skip(compact, 'sidebar + keyboard shortcuts are regular-size only')
    await app.goto('/studio')
    const sidebar = page.getByRole('navigation', { name: '主导航' })
    await expect(sidebar).toBeVisible()
    await page.getByRole('button', { name: '隐藏侧边栏' }).click()
    await expect(sidebar).toBeHidden()
    await page.getByRole('button', { name: '显示侧边栏' }).click()
    await expect(sidebar).toBeVisible()

    await page.getByRole('main').click({ position: { x: 10, y: 10 } })
    await page.keyboard.press('ControlOrMeta+4')
    await expect(page).toHaveURL(/\/machine$/)
    await page.keyboard.press('ControlOrMeta+5')
    await expect(page).toHaveURL(/\/jobs$/)
    await page.keyboard.press('ControlOrMeta+3')
    await expect(page).toHaveURL(/\/fonts/)
  })

  test('phone: tab bar has four tabs + 更多, which holds logout; no horizontal overflow', async ({ app, page, compact }) => {
    test.skip(!compact, 'compact layout only')
    await app.goto('/studio')
    const tabs = page.getByRole('navigation', { name: '主导航' })
    await expect(tabs.getByRole('link')).toHaveCount(4)
    await expect(tabs.getByRole('link', { name: '创作', exact: true })).toBeVisible()
    await tabs.getByRole('button', { name: '更多' }).click()
    const sheet = page.getByRole('dialog', { name: '更多' })
    for (const t of ['设置', '系统', '退出登录']) await expect(sheet.getByRole('button', { name: t, exact: true })).toBeVisible()
    await sheet.getByRole('button', { name: '关闭' }).click()
    await expect(sheet).toBeHidden()
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(overflow, 'page must not scroll horizontally on a 390px phone').toBeLessThanOrEqual(0)
  })
})
