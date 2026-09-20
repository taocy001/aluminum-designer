import { test, expect } from '@playwright/test'
import { openApp, enterDraw, drawMember, drawExact, clickWorld, store, tool, endpoints, r } from './helpers'
import fs from 'node:fs'

async function toNavigate(page: any) {
  await page.keyboard.press('Escape')
  if ((await tool(page)).viewMode !== 'navigate') await page.keyboard.press('Escape')
}

test.describe('Sidebar properties', () => {
  test.beforeEach(async ({ page }) => {
    await openApp(page)
    await enterDraw(page, '2020')
    await drawMember(page, [0, 0, 0], [400, 10, 0])
    await toNavigate(page)
    await clickWorld(page, [200, 10, 0])
    await expect(page.getByTestId('properties')).toBeVisible()
  })

  test('length field commits on Enter and refuses invalid values', async ({ page }) => {
    const len = page.getByTestId('properties').locator('input[type=number]').first()
    await len.fill('650'); await len.press('Enter')
    expect((await store(page)).profiles[0].length).toBe(650)
    await len.fill('3'); await len.press('Enter')
    expect((await store(page)).profiles[0].length).toBe(650)
    await expect(page.getByTestId('toasts')).toContainText('太短')
    await expect(len).toHaveValue('650')
    await page.keyboard.press('Control+z')
    expect((await store(page)).profiles[0].length).toBe(400)
  })

  test('typed coordinates are applied exactly, including below the floor', async ({ page }) => {
    const inputs = page.getByTestId('properties').locator('input[type=number]')
    await inputs.nth(1).fill('120'); await inputs.nth(1).press('Enter')   // X
    await inputs.nth(2).fill('-50'); await inputs.nth(2).press('Enter')   // Y: typed values are deliberate
    await inputs.nth(3).fill('80'); await inputs.nth(3).press('Enter')    // Z
    expect((await store(page)).profiles[0].position.map(r)).toEqual([120, -50, 80])
    // gestures still keep members above the floor
    await page.keyboard.press('PageDown')
    expect(r((await store(page)).profiles[0].position[1])).toBe(10)
  })

  test('spec select changes the profile and re-lifts it', async ({ page }) => {
    await page.getByTestId('properties').locator('select').selectOption('4040')
    const p = (await store(page)).profiles[0]
    expect(p.spec).toBe('4040')
    expect(r(p.position[1])).toBe(20)
  })

  test('flip swaps start and end; rotate turns 90°; duplicate adds a copy', async ({ page }) => {
    await page.getByTestId('properties').getByTitle('反向').click()
    let p = (await store(page)).profiles[0]
    expect(p.position.map(r)).toEqual([400, 10, 0])
    expect(endpoints(p).end.map(r)).toEqual([0, 10, 0])
    await page.getByTestId('rot-y-plus').click()
    p = (await store(page)).profiles[0]
    expect(Math.abs(r(endpoints(p).end[2] - endpoints(p).start[2]))).toBe(400)
    await page.getByTestId('properties').getByTitle(/复制/).click()
    expect((await store(page)).profiles).toHaveLength(2)
    await expect(page.getByTestId('toasts')).toContainText('已复制')
  })

  test('trash button deletes; undo/redo buttons work and disable correctly', async ({ page }) => {
    await page.getByTestId('properties').getByTitle('删除').click()
    expect((await store(page)).profiles).toHaveLength(0)
    const undo = page.getByTitle(/撤销/); const redo = page.getByTitle(/重做/)
    await expect(redo).toBeDisabled()
    await undo.click()
    expect((await store(page)).profiles).toHaveLength(1)
    await expect(redo).toBeEnabled()
    await redo.click()
    expect((await store(page)).profiles).toHaveLength(0)
  })
})

test.describe('BOM, project files, clear', () => {
  test.beforeEach(async ({ page }) => { await openApp(page) })

  test('BOM groups by spec and cut length, counts brackets and overall size', async ({ page }) => {
    await enterDraw(page, '2020')
    await drawMember(page, [0, 0, 0], [600, 10, 0])
    await drawMember(page, [0, 0, 400], [600, 10, 400])
    await drawMember(page, [200, 10, 0], [200, 10, 400])
    await drawMember(page, [400, 10, 0], [400, 10, 400])
    await expect(page.getByTestId('bom-count')).toHaveText('4')
    await expect(page.getByTestId('bom-brackets')).toHaveText('4')
    await expect(page.getByTestId('bom-table')).toContainText('600 mm')
    await expect(page.getByTestId('bom-table')).toContainText('380 mm')
    await expect(page.getByTestId('bom-table').locator('div', { hasText: '380 mm' }).first()).toContainText('×2')
    await expect(page.getByTestId('bom-overall')).toHaveText('600×420×20')
  })

  test('CSV export downloads grouped rows', async ({ page }) => {
    await enterDraw(page, '2020')
    await drawMember(page, [0, 0, 0], [600, 10, 0])
    await drawMember(page, [0, 0, 400], [600, 10, 400])
    const [dl] = await Promise.all([page.waitForEvent('download'), page.getByText('导出物料清单').click()])
    const path = await dl.path()
    const csv = fs.readFileSync(path!, 'utf8')
    expect(csv).toContain('Profile,2020,600,2')
    expect(csv).toContain('Bracket(recommended)')
  })

  test('save then open a project round-trips the document', async ({ page }) => {
    await enterDraw(page, '2020')
    await drawMember(page, [0, 0, 0], [600, 10, 0])
    await drawExact(page, [0, 10, 0], [0, 300, 0], 700)
    const before = (await store(page)).profiles
    const [dl] = await Promise.all([page.waitForEvent('download'), page.getByText('保存工程').click()])
    const path = await dl.path()
    const doc = JSON.parse(fs.readFileSync(path!, 'utf8'))
    expect(doc.profiles).toHaveLength(2)
    // clear, then import
    await page.getByTestId('clear-all').click()
    await expect(page.getByTestId('clear-all')).toContainText('再点一次')
    await page.getByTestId('clear-all').click()
    expect((await store(page)).profiles).toHaveLength(0)
    await page.locator('input[type=file]').setInputFiles(path!)
    await expect(page.getByTestId('toasts')).toContainText('已载入')
    const after = (await store(page)).profiles
    expect(after.map((p) => [p.id, p.length, p.position])).toEqual(before.map((p) => [p.id, p.length, p.position]))
    await page.keyboard.press('Control+z')
    expect((await store(page)).profiles).toHaveLength(0)
  })

  test('bad project file shows an error and leaves the document intact', async ({ page }) => {
    await enterDraw(page, '2020')
    await drawMember(page, [0, 0, 0], [600, 10, 0])
    await page.locator('input[type=file]').setInputFiles({ name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from('{"profiles":[{"id":1}]}') })
    await expect(page.getByTestId('toasts')).toContainText('无法读取')
    expect((await store(page)).profiles).toHaveLength(1)
  })

  test('clear needs a second click and times out otherwise', async ({ page }) => {
    await enterDraw(page, '2020')
    await drawMember(page, [0, 0, 0], [600, 10, 0])
    await page.getByTestId('clear-all').click()
    await page.waitForTimeout(3300)
    await expect(page.getByTestId('clear-all')).not.toContainText('再点一次')
    expect((await store(page)).profiles).toHaveLength(1)
  })

  test('language toggle switches labels', async ({ page }) => {
    await page.getByText('English').click()
    await expect(page.getByText('ALUFRAME DESIGNER')).toBeVisible()
    await expect(page.getByText('Fit view')).toBeVisible()
    await page.getByText('中文').click()
    await expect(page.getByText('铝型材框架设计器')).toBeVisible()
  })

  test('document persists across reload', async ({ page }) => {
    await enterDraw(page, '2020')
    await drawMember(page, [0, 0, 0], [600, 10, 0])
    await page.reload()
    await page.waitForFunction(() => (window as any).__aluframe?.setView)
    expect((await store(page)).profiles).toHaveLength(1)
    await expect(page.getByTestId('bom-count')).toHaveText('1')
  })
})
