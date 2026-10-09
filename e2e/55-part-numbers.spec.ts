import { expect, test, type Page } from '@playwright/test'
import { openApp, useDownloadFallback } from './helpers'

const drawing = {
  version: 9, throughRule: 'posts',
  profiles: [{ id: 'rail', spec: '2020', length: 600, position: [0, 10, 0], quaternion: [0, 0, 0, 1],
    fixedTrims: { start: 20, end: 0 }, miterCuts: [], holes: [] }],
  connectors: [{ id: 'bracket', type: 'bracket', series: 20, position: [100, 20, 0], quaternion: [0, 0, 0, 1] }],
  panels: [{ id: 'shelf', width: 300, height: 300, thickness: 18, material: 'ply',
    position: [-400, 200, 0], quaternion: [0, 0, 0, 1] }],
  fittings: [{ id: 'drawer', kind: 'drawer', width: 400, height: 180, depth: 400, frame: 20, material: 'ply',
    position: [400, 200, 0], quaternion: [0, 0, 0, 1], open: 1 }],
  equipment: [{ id: 'device', name: '设备 <img src=x onerror=alert(1)>', width: 200, height: 200, depth: 200,
    position: [800, 100, 0], quaternion: [0, 0, 0, 1],
    clearance: { left: 0, right: 0, bottom: 0, top: 0, back: 0, front: 0 } }],
}

async function exported(page: Page, format: string) {
  await page.getByTestId('sidebar-tab-inspect').click()
  const event = page.waitForEvent('download')
  await page.getByTestId(`export-${format}`).click()
  const download = await event
  const chunks: Buffer[] = []
  for await (const chunk of (await download.createReadStream())!) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

test('part numbers match the UI, cutting list, CAD and offline printable assembly guide', async ({ page, browser }, testInfo) => {
  await useDownloadFallback(page)
  await openApp(page)
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.locator('input[type="file"]').setInputFiles({
    name: 'parts.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(drawing)),
  })
  await expect(page.getByTestId('bom-count')).toHaveText('1')
  await page.getByTestId('part-numbers-toggle').click()
  await expect(page.getByTestId('part-numbers-toggle')).toHaveAttribute('aria-pressed', 'true')
  await page.evaluate(() => (window as any).__aluframe.store.getState().selectItems(['drawer']))
  await expect(page.getByTestId('selected-part-numbers')).toContainText('F-drawer')
  await page.getByTestId('selected-part-numbers').locator('summary').click()
  await expect(page.getByTestId('selected-part-numbers')).toContainText('F-drawer.B-front')
  await page.getByTestId('sidebar-tab-inspect').click()
  await page.getByTestId('bom-table').locator('summary').first().click()
  await expect(page.getByTestId('bom-part-numbers').first()).toHaveText('P-rail')

  const bom = await exported(page, 'bom')
  const cutting = await exported(page, 'cutting')
  const dxf = await exported(page, 'dxf')
  const step = await exported(page, 'step')
  const html = await exported(page, 'assembly')
  for (const number of ['P-rail', 'C-bracket', 'B-shelf', 'F-drawer.B-front', 'F-drawer.B-side-left']) {
    for (const content of [bom, dxf, step, html]) expect(content).toContain(number)
  }
  expect(cutting).toContain('P-rail')
  expect(cutting).toContain('580')
  expect(bom).toContain('Profile,2020,2020,580,1')
  expect(step).toContain("PRODUCT('P-rail','P-rail'")
  expect(html).toContain('580 mm')
  for (const content of [bom, cutting, dxf, step]) expect(content).not.toContain('设备')

  const context = await browser.newContext({ offline: true })
  const guide = await context.newPage()
  const requests: string[] = []
  guide.on('request', (request) => requests.push(request.url()))
  guide.on('pageerror', (error) => errors.push(error.message))
  await guide.setContent(html)
  await expect(guide.getByRole('heading', { name: '模型概览', exact: true })).toBeVisible()
  await expect(guide.locator('.assembly-step').first()).toBeVisible()
  expect(await guide.locator('script,img,iframe,link').count()).toBe(0)
  for (const selector of ['.overview', '.materials', '.cutting', '.assembly-step']) {
    await expect(guide.locator(selector).first()).toContainText('P-rail')
  }
  await guide.locator('.overview a[data-marker-number="P-rail"] rect').click()
  await expect(guide.locator('#part-P-rail')).toBeInViewport()
  await guide.emulateMedia({ media: 'print' })
  const pdf = await guide.pdf({ path: testInfo.outputPath('assembly.pdf'), preferCSSPageSize: true })
  expect(pdf.byteLength).toBeGreaterThan(10_000)
  await guide.setViewportSize({ width: 390, height: 844 })
  await guide.emulateMedia({ media: 'screen' })
  expect(await guide.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  expect(requests).toEqual([])
  expect(errors).toEqual([])
  await context.close()
})

test('connector-only and equipment-only exports retain their different material scopes', async ({ page }) => {
  await openApp(page)
  await page.evaluate((doc) => (window as any).__aluframe.store.getState().loadDocument(doc), {
    ...drawing, profiles: [], panels: [], fittings: [], equipment: [],
  })
  await expect(page.getByTestId('export-dxf')).toBeEnabled()
  expect(await exported(page, 'dxf')).toContain('C-bracket')
  await page.evaluate((doc) => (window as any).__aluframe.store.getState().loadDocument(doc), {
    ...drawing, profiles: [], connectors: [], panels: [], fittings: [],
  })
  for (const format of ['bom', 'cutting', 'dxf', 'step']) await expect(page.getByTestId(`export-${format}`)).toBeDisabled()
  await expect(page.getByTestId('export-assembly')).toBeEnabled()
  const html = await exported(page, 'assembly')
  expect(html).toContain('无装配零件。')
  expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
  expect(html).not.toContain('<img')
})
