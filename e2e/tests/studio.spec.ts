import type { Page } from '@playwright/test'
import type { Api } from '../helpers/api'
import { uniq } from '../helpers/env'
import { expect, isPlaceholder, test } from '../helpers/fixtures'

interface Element {
  id: string
  type: string
  props: Record<string, unknown>
  transform: { x: number; y: number }
}
interface Project {
  id: string
  name: string
  rev: number
  doc: { paper: { paper_id: string | null; spec: { width_mm: number; height_mm: number } | null }; pages: { elements: Element[] }[] }
}

const LONG_TEXT = '永和九年岁在癸丑暮春之初会于会稽山阴之兰亭修禊事也群贤毕至少长咸集此地有崇山峻岭茂林修竹又有清流激湍映带左右引以为流觞曲水列坐其次'

async function fontId(api: Api, display: string) {
  const fonts = await api.get<{ id: string; display_name: string }[]>(`/fonts?q=${encodeURIComponent(display)}`)
  const f = fonts.find((x) => x.display_name === display) ?? fonts[0]
  expect(f, `font ${display} installed`).toBeTruthy()
  return f.id
}

/** A project with one text element, created through the API (arrange step). */
async function projectWithText(api: Api, name: string, text: string, font: string) {
  return api.post<Project>('/projects', {
    name,
    doc: {
      version: 1,
      name,
      paper: { paper_id: 'a4-normal' },
      pages: [
        {
          id: 'p1',
          elements: [
            {
              id: 'e1',
              type: 'text',
              name: '正文',
              transform: { x: 30, y: 30, scale: 1, sx: 1, sy: 1, rotation: 0 },
              z: 0,
              locked: false,
              hidden: false,
              pen: 1,
              props: { text, font_id: font, size_mm: 8, line_height: 1.3, char_space: 0, align: 'L', box: { w: 150, h: 120 }, seed: 1, jitter: {}, missing_glyph: 'box' },
            },
          ],
        },
      ],
    },
  })
}

/** "36 笔 · 0.2 m · 抬笔 36 次 · 21 秒" under the canvas. */
async function strokeCount(page: Page) {
  const t = await page.getByText(/^\d[\d,]* 笔 · /).first().innerText().catch(() => '')
  const m = /^([\d,]+) 笔/.exec(t)
  return m ? Number(m[1].replace(/,/g, '')) : -1
}

async function openStudio(page: Page, path: string) {
  await page.goto(path)
  await expect(page.getByRole('main')).toBeVisible()
  test.fixme(await isPlaceholder(page), 'studio not implemented yet (placeholder page)')
  await expect(page.getByRole('application').first()).toBeVisible({ timeout: 20_000 })
}

test.describe('studio', () => {
  test('create project → add text box → font & size → preview → save → reload persists', async ({ app, page, api, compact }) => {
    test.skip(compact, 'desktop editing flow; compact covered by the smoke test')
    const name = uniq('E2E项目')
    await app.goto('/projects')
    test.fixme((await page.getByRole('button', { name: '新建项目' }).count()) === 0, 'projects page has no 新建项目 yet')
    await page.getByRole('button', { name: '新建项目' }).first().click()
    const dlg = page.getByRole('dialog', { name: '新建项目' })
    await dlg.getByRole('radio', { name: '空白项目' }).click()
    await dlg.getByLabel('项目名称').fill(name)
    await dlg.getByRole('button', { name: '创建并打开' }).click()
    await expect(page).toHaveURL(/\/studio\/[A-Za-z0-9]+$/)
    const id = new URL(page.url()).pathname.split('/').pop()!
    await openStudio(page, `/studio/${id}`)
    await expect(page.getByRole('heading', { level: 1, name })).toBeVisible()

    // free layout + text tool, drag a box on the paper
    await page.getByRole('radiogroup', { name: '文档模式' }).getByRole('radio', { name: '自由' }).click()
    await page.getByRole('button', { name: /^文本框/ }).click()
    const canvas = page.getByRole('application').first()
    const bb = (await canvas.boundingBox())!
    await page.mouse.move(bb.x + bb.width * 0.35, bb.y + bb.height * 0.3)
    await page.mouse.down()
    await page.mouse.move(bb.x + bb.width * 0.65, bb.y + bb.height * 0.42, { steps: 6 })
    await page.mouse.up()
    await expect(canvas).toHaveAccessibleName(/1 个元素/)

    const inspector = page.getByRole('complementary', { name: '检查器' })
    await inspector.getByRole('textbox', { name: '文字内容' }).fill('你好 E2E')
    const size = inspector.getByRole('spinbutton', { name: '字号' })
    await size.fill('12')
    await size.press('Tab')

    // font picker: combobox → searchable listbox
    await inspector.getByRole('combobox', { name: '字体' }).click()
    await page.getByPlaceholder('搜索字体').fill('xxn6900')
    await page.getByRole('listbox', { name: '字体' }).getByRole('option', { name: /xxn6900/ }).first().click()
    await expect(inspector.getByRole('combobox', { name: '字体' })).toContainText('xxn6900')

    // preview renders strokes
    await expect.poll(() => strokeCount(page), { timeout: 20_000, message: 'preview stroke count' }).toBeGreaterThan(0)

    // autosave (and Mod+S) → 已保存
    await page.keyboard.press('ControlOrMeta+s')
    await expect(page.getByRole('banner').getByText('已保存')).toBeVisible({ timeout: 15_000 })
    const saved = await api.get<Project>(`/projects/${id}`)
    const el = saved.doc.pages[0].elements.find((e) => e.type === 'text')
    expect(el, 'text element persisted').toBeTruthy()
    expect(el!.props).toMatchObject({ text: '你好 E2E', size_mm: 12 })
    expect(String(el!.props.font_id)).toContain('xxn6900')

    await page.reload()
    await openStudio(page, `/studio/${id}`)
    await expect(page.getByRole('application').first()).toHaveAccessibleName(/1 个元素/)
    await expect.poll(() => strokeCount(page), { timeout: 20_000 }).toBeGreaterThan(0)
  })

  test('paper picker: custom 207×294 applies to the page and is saved', async ({ page, api, compact }) => {
    test.skip(compact, 'desktop inspector; compact uses sheets')
    const p = await api.post<Project>('/projects', { name: uniq('E2E纸张'), doc: { version: 1, name: 'paper', paper: { paper_id: 'a4-normal' }, pages: [{ id: 'p1', elements: [] }] } })
    await openStudio(page, `/studio/${p.id}`)
    const inspector = page.getByRole('complementary', { name: '检查器' })
    await inspector.getByRole('button', { name: /209 × 296 mm/ }).click()
    const dlg = page.getByRole('dialog', { name: '选择纸张' })
    await expect(dlg).toBeVisible()
    await dlg.getByRole('spinbutton', { name: '宽' }).fill('207')
    await dlg.getByRole('spinbutton', { name: '宽' }).press('Tab')
    await dlg.getByRole('spinbutton', { name: '高' }).fill('294')
    await dlg.getByRole('spinbutton', { name: '高' }).press('Tab')
    await dlg.getByRole('button', { name: '应用', exact: true }).click()
    await expect(dlg).toBeHidden()
    await expect(page.getByText(/纸张 207\s*×\s*294 毫米/).first()).toBeVisible()
    await expect
      .poll(async () => {
        const d = (await api.get<Project>(`/projects/${p.id}`)).doc
        return d.paper.spec ? [d.paper.spec.width_mm, d.paper.spec.height_mm] : null
      }, { timeout: 15_000, message: 'custom paper saved in project doc' })
      .toEqual([207, 294])
  })

  test('print sheet → job runs on FakeGrbl to done, mini-player shows progress', async ({ app, page, machine, compact }) => {
    test.skip(compact, 'desktop print sheet')
    const name = uniq('E2E打印')
    const p = await projectWithText(machine, name, LONG_TEXT, await fontId(machine, 'xxn6900'))
    await openStudio(page, `/studio/${p.id}`)
    await app.waitLive()
    await expect.poll(() => strokeCount(page), { timeout: 30_000 }).toBeGreaterThan(50)

    await page.getByRole('button', { name: '打印', exact: true }).click()
    const sheet = page.getByRole('dialog', { name: /打印/ })
    await expect(sheet).toBeVisible()
    const start = sheet.getByRole('button', { name: '开始打印' })
    await expect(start).toBeDisabled() // until 纸张和笔已就位 is ticked (02-ux §3.3)
    await sheet.getByRole('checkbox', { name: '纸张和笔已就位' }).check()
    await expect(start).toBeEnabled({ timeout: 30_000 })
    await start.click()
    await expect(sheet).toBeHidden()

    const mini = app.miniPlayer()
    await expect(mini).toBeVisible({ timeout: 15_000 })
    await expect(mini).toContainText(name)
    await expect.poll(async () => Number(/(\d+)%/.exec(await mini.innerText())?.[1] ?? -1), { timeout: 20_000 }).toBeGreaterThan(0)
    await expect(mini).toContainText('已完成', { timeout: 60_000 })
    const jobs = await machine.get<{ name: string; status: string }[]>('/jobs?limit=20')
    expect(jobs.find((j) => j.name.startsWith(name))?.status).toBe('done')
  })

  test('phone: studio opens with canvas and print action', async ({ page, api, compact }) => {
    test.skip(!compact, 'compact smoke')
    const p = await projectWithText(api, uniq('E2E手机'), '你好', await fontId(api, 'xxn6900'))
    await openStudio(page, `/studio/${p.id}`)
    await expect(page.getByRole('application').first()).toHaveAccessibleName(/1 个元素/)
    await expect(page.getByRole('button', { name: '打印', exact: true }).first()).toBeVisible()
  })
})
