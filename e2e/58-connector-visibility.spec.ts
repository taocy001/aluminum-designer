import { test, expect, type Page } from '@playwright/test'
import { chooseConnector, openApp, setView, settle, store, w2c } from './helpers'

const UP = [-Math.SQRT1_2, 0, 0, Math.SQRT1_2]
const ALONG_X = [0, Math.SQRT1_2, 0, Math.SQRT1_2]

async function hoverState(page: Page) {
  return page.evaluate(() => {
    const state = (window as any).__aluframe.tool.getState()
    return { target: state.hoverTargetId, point: state.currentPoint?.toArray() ?? null }
  })
}

test.beforeEach(async ({ page }) => { await openApp(page) })

test('corner picking skips a joint hidden by the assembly step and finds it when shown', async ({ page }) => {
  await page.evaluate(({ up, alongX }) => {
    const profile = (id: string, position: number[], quaternion: number[], length = 300) => ({
      id, spec: '2020', position, quaternion, length, miterCuts: [], holes: [],
    })
    const api = (window as any).__aluframe
    api.store.getState().loadDocument({
      profiles: [profile('floor-post', [-400, 0, 0], up, 100),
        profile('hidden-x', [0, 100, 0], alongX), profile('hidden-y', [0, 100, 0], up),
        profile('hidden-z', [0, 100, 0], [0, 0, 0, 1])],
      connectors: [], panels: [], fittings: [], equipment: [], throughRule: 'rails',
    })
    api.tool.getState().setBuildStep(1)
  }, { up: UP, alongX: ALONG_X })
  await expect.poll(() => page.evaluate(() => {
    const ids: string[] = []
    ;(window as any).__aluframe.sceneRoot.traverseVisible((object: any) => {
      if (object.isMesh && object.userData.profileId) ids.push(object.userData.profileId)
    })
    return ids.sort()
  })).toEqual(['floor-post'])
  await setView(page, [230, 290, 310], [35, 135, 35])
  await chooseConnector(page, 'inside-corner')
  const pointer = await w2c(page, [0, 100, 0])
  await page.mouse.move(pointer.x, pointer.y)
  await settle(page)
  await expect.poll(async () => (await hoverState(page)).target).toBeNull()
  await expect(page.getByTestId('connector-seat-hud')).toHaveAttribute('data-seat-count', '0')
  const before = await store(page)
  await page.mouse.click(pointer.x, pointer.y)
  await settle(page)
  const after = await store(page)
  expect(after.connectors).toEqual(before.connectors)
  expect(after.past).toBe(before.past)

  await page.evaluate(() => (window as any).__aluframe.tool.getState().setBuildStep(2))
  await expect.poll(() => page.evaluate(() => {
    const ids: string[] = []
    ;(window as any).__aluframe.sceneRoot.traverseVisible((object: any) => {
      if (object.isMesh && object.userData.profileId) ids.push(object.userData.profileId)
    })
    return ids.sort()
  })).toEqual(['floor-post', 'hidden-x'])
  await page.mouse.move(pointer.x + 1, pointer.y)
  await page.mouse.move(pointer.x, pointer.y)
  await expect.poll(async () => (await hoverState(page)).target).toBe('hidden-x')
  await expect(page.getByTestId('connector-seat-hud')).toHaveAttribute('data-seat-count', '0')

  await page.evaluate(() => (window as any).__aluframe.tool.getState().setBuildStep(null))
  await expect.poll(() => page.evaluate(() => {
    const ids: string[] = []
    ;(window as any).__aluframe.sceneRoot.traverseVisible((object: any) => {
      if (object.isMesh && object.userData.profileId) ids.push(object.userData.profileId)
    })
    return ids.sort()
  })).toEqual(['floor-post', 'hidden-x', 'hidden-y', 'hidden-z'])
  await page.mouse.move(pointer.x + 1, pointer.y)
  await page.mouse.move(pointer.x, pointer.y)
  await expect(page.getByTestId('connector-seat-hud')).toHaveAttribute('data-seat-count', '6')
  await expect.poll(async () => (await hoverState(page)).target).toMatch(/^hidden-/)

  await page.getByTestId('connector-joint-lock').click()
  await page.evaluate(() => (window as any).__aluframe.tool.getState().setBuildStep(2))
  await settle(page)
  await page.mouse.move(pointer.x + 1, pointer.y)
  await page.mouse.move(pointer.x, pointer.y)
  await expect(page.getByTestId('connector-seat-hud')).toHaveAttribute('data-seat-count', '0')
  await expect(page.getByTestId('connector-joint-lock')).toHaveCount(0)
  expect((await store(page)).connectors).toEqual(before.connectors)
  expect((await store(page)).past).toBe(before.past)
})

test('sectioned corner picking uses the remaining exit surface and ignores a fully clipped member', async ({ page }) => {
  await page.evaluate(() => {
    const api = (window as any).__aluframe
    api.store.getState().loadDocument({
      profiles: [{ id: 'sectioned', spec: '4040-B6', length: 200, position: [0, 100, 0],
        quaternion: [0, 0, 0, 1], fixedTrims: { start: 20, end: 30 }, miterCuts: [], holes: [] }],
      connectors: [], panels: [], fittings: [], equipment: [], throughRule: 'rails',
    })
    api.tool.getState().setSection({ axis: 'x', at: 0, flip: false })
  })
  await setView(page, [200, 150, 70], [0, 100, 70])
  await chooseConnector(page, 'inside-corner')
  const pointer = await w2c(page, [0, 100, 70])
  await page.mouse.move(pointer.x, pointer.y)
  await expect.poll(async () => (await hoverState(page)).target).toBe('sectioned')
  await expect.poll(async () => Number((await hoverState(page)).point?.[0].toFixed(5))).toBe(-20)

  await page.evaluate(() => (window as any).__aluframe.tool.getState().setSection({ axis: 'x', at: -30, flip: false }))
  await settle(page)
  await page.mouse.move(pointer.x + 1, pointer.y)
  await page.mouse.move(pointer.x, pointer.y)
  await expect.poll(async () => (await hoverState(page)).target).toBeNull()
  await expect(page.getByTestId('connector-seat-hud')).toHaveAttribute('data-seat-count', '0')
  const before = await store(page)
  await page.mouse.click(pointer.x, pointer.y)
  await settle(page)
  const after = await store(page)
  expect(after.connectors).toEqual(before.connectors)
  expect(after.past).toBe(before.past)
})

test('a three-way seat disappears when its third supporting member is fully sectioned away', async ({ page }) => {
  await page.evaluate(({ up, alongX }) => {
    const profile = (id: string, position: number[], quaternion: number[]) => ({
      id, spec: '4040', position, quaternion, length: 280, miterCuts: [], holes: [],
    })
    const api = (window as any).__aluframe
    api.store.getState().loadDocument({
      profiles: [profile('end-x', [-300, 100, 0], alongX), profile('end-y', [0, -200, 0], up),
        profile('end-z', [0, 100, -300], [0, 0, 0, 1])],
      connectors: [], panels: [], fittings: [], equipment: [], throughRule: 'rails',
    })
  }, { up: UP, alongX: ALONG_X })
  await setView(page, [250, 220, 280], [0, 80, 0])
  await chooseConnector(page, 'corner-3way')
  const pointer = await w2c(page, [0, 60, 0])
  await page.mouse.move(pointer.x, pointer.y)
  await expect.poll(async () => Number(await page.getByTestId('connector-seat-hud').getAttribute('data-seat-count'))).toBeGreaterThan(0)
  const before = await store(page)

  // Keep x >= -10: the X member ends at -20, while the two other members remain visible.
  await page.evaluate(() => (window as any).__aluframe.tool.getState().setSection({ axis: 'x', at: -10, flip: true }))
  await settle(page)
  await page.mouse.move(pointer.x + 1, pointer.y)
  await page.mouse.move(pointer.x, pointer.y)
  await expect.poll(async () => (await hoverState(page)).target).toBe('end-y')
  await expect(page.getByTestId('connector-seat-hud')).toHaveAttribute('data-seat-count', '0')
  await page.mouse.click(pointer.x, pointer.y)
  await settle(page)
  expect((await store(page)).connectors).toEqual(before.connectors)
  expect((await store(page)).past).toBe(before.past)

  await page.evaluate(() => (window as any).__aluframe.tool.getState().setSection(null))
  await settle(page)
  await page.mouse.move(pointer.x + 1, pointer.y)
  await page.mouse.move(pointer.x, pointer.y)
  await expect.poll(async () => Number(await page.getByTestId('connector-seat-hud').getAttribute('data-seat-count'))).toBeGreaterThan(0)
})
