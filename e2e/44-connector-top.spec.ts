import { selectedSolidTop } from '../src/utils/selectionBounds'
import { test, expect } from '@playwright/test'
import { openApp, setView, settle } from './helpers'

test('selection work planes coincide with the real connector solids across series and rotations', async ({ page }) => {
  await openApp(page)
  // Geometry fixtures isolate the bounds calculation; the work-plane action itself uses UI.
  const definitions = [
    { type: 'foot', series: 20, profileSpec: '4040-B6', rotation: [0, 0, 0], top: 112.1 },
    { type: 'gusset', series: 40, profileSpec: '4040', rotation: [0, 0, 0], top: 140 },
    { type: 'foot', series: 40, profileSpec: '4040', rotation: [Math.PI / 2, 0, 0], top: 119.7 },
    { type: 'gusset', series: 40, profileSpec: '4040', rotation: [0, 0, Math.PI / 4], top: 128.284 },
    { type: 'foot', series: 30, profileSpec: '3030', rotation: [0, 0, Math.PI / 4], top: 109.899 },
  ]
  const fixtures = await page.evaluate((definitions) => {
    const w = (window as any).__aluframe, T = w.THREE
    const connectors = definitions.map(({ type, series, profileSpec, rotation }, index) => ({
      id: `part-${index}`, type, series, profileSpec, position: [index * 100, 100, 0],
      quaternion: new T.Quaternion().setFromEuler(new T.Euler(...rotation)).toArray(),
    }))
    w.store.getState().loadDocument({ profiles: [], panels: [], fittings: [], connectors, throughRule: 'rails' })
    return connectors.map((part: any) => part.id)
  }, definitions)
  await setView(page, [500, 360, 650], [200, 100, 0])
  for (const [index, id] of fixtures.entries()) {
    await page.evaluate((id) => (window as any).__aluframe.store.getState().selectItems([id]), id)
    await settle(page)
    const actualTop = await page.evaluate((id) => {
      const w = (window as any).__aluframe, v = new w.THREE.Vector3()
      let top = -Infinity, count = 0
      w.sceneRoot.updateMatrixWorld(true)
      w.sceneRoot.traverse((mesh: any) => {
          const instance = mesh.userData.partIds?.indexOf(id) ?? -1
          if (!mesh.isInstancedMesh || instance < 0) return
          const matrix = new w.THREE.Matrix4()
          mesh.getMatrixAt(instance, matrix)
          matrix.premultiply(mesh.matrixWorld)
          const vertices = mesh.geometry.getAttribute('position')
          for (let i = 0; i < vertices.count; i++) {
            v.fromBufferAttribute(vertices, i).applyMatrix4(matrix)
            top = Math.max(top, v.y); count++
          }
      })
      return { top: Math.round(top * 1000) / 1000, count }
    }, id)
    expect(actualTop.count).toBeGreaterThan(20)
    // B6 plate screws project 12.1 mm; 40-4332 reaches 40 mm, or 40/√2 after a 45° turn.
    // The fixed foot radius is 19.7 mm; its tilted M8 stud reaches (10 + 4)/√2.
    expect(actualTop.top).toBeCloseTo(definitions[index].top, 3)
    await page.getByTestId('sidebar-tab-add').click()
    await page.getByTestId('work-plane-from-selection').click()
    await expect(page.getByTestId('work-plane')).toHaveValue(String(actualTop.top))
    expect(await page.evaluate(() => (window as any).__aluframe.tool.getState().workPlaneY)).toBe(actualTop.top)
  }
  await page.screenshot({ path: test.info().outputPath('connector-solid-work-plane.png') })
})

test('every connector keeps the same shared solid after another instance is removed and remounted', async ({ page }) => {
  await openApp(page)
  const problems: string[] = []
  page.on('pageerror', (error) => problems.push(error.message))
  const types = ['bracket', 'inside-corner', 'gusset', 't-bracket', 'corner-3way', 'flat-plate', 'joining-plate',
    'end-cap', 'caster-mount', 'foot', 'cross-bracket', 't-nut', 'hinge', 'pivot']
  await page.evaluate((types) => {
    const w = (window as any).__aluframe, T = w.THREE
    const connectors = types.flatMap((type, index) => [0, 1].map((copy) => ({ id: `${type}-${copy}`, type,
      series: [20, 30, 40][index % 3], position: [(index % 7) * 100, 120 + copy * 100, Math.floor(index / 7) * 120],
      quaternion: new T.Quaternion().setFromEuler(new T.Euler(0.37, -0.51, 0.63)).toArray() })))
    w.store.getState().loadDocument({ profiles: [], panels: [], fittings: [], connectors, throughRule: 'rails' })
  }, types)
  await settle(page)
  const measure = async () => {
    const document = await page.evaluate(() => {
      const s = (window as any).__aluframe.store.getState()
      return { profiles: s.profiles, connectors: s.connectors, panels: s.panels, fittings: s.fittings, equipment: s.equipment }
    })
    const actual = await page.evaluate(() => {
      const w = (window as any).__aluframe, v = new w.THREE.Vector3()
      const results: Array<{ id: string; actual: number }> = []
      w.sceneRoot.updateMatrixWorld(true)
      for (const connector of w.store.getState().connectors) {
        let actual = -Infinity
        w.sceneRoot.traverse((mesh: any) => {
            const instance = mesh.userData.partIds?.indexOf(connector.id) ?? -1
            if (!mesh.isInstancedMesh || instance < 0) return
            const matrix = new w.THREE.Matrix4()
            mesh.getMatrixAt(instance, matrix)
            matrix.premultiply(mesh.matrixWorld)
            const vertices = mesh.geometry.getAttribute('position')
            for (let i = 0; i < vertices.count; i++) actual = Math.max(actual,
              v.fromBufferAttribute(vertices, i).applyMatrix4(matrix).y)
        })
        results.push({ id: connector.id, actual: Math.round(actual * 1000) / 1000 })
      }
      return results
    })
    return actual.map(result => ({ ...result, computed: selectedSolidTop(document, [result.id]) }))
  }
  const original = await measure()
  expect(original).toHaveLength(28)
  for (const result of original) expect(result.computed, result.id).toBe(result.actual)
  const saved = await page.evaluate(() => {
    const store = (window as any).__aluframe.store.getState()
    const document = { profiles: [], panels: [], fittings: [], connectors: store.connectors, throughRule: 'rails' }
    store.loadDocument({ ...document, connectors: store.connectors.filter((part: any) => part.id.endsWith('-1')) })
    return document
  })
  await settle(page)
  expect(await measure()).toEqual(original.filter((result) => result.id.endsWith('-1')))
  await page.evaluate((document) => (window as any).__aluframe.store.getState().loadDocument(document), saved)
  await settle(page)
  expect(await measure()).toEqual(original)
  expect(problems).toEqual([])
})

test('connector instances keep identity through highlighting, hiding, deletion and undo', async ({ page }) => {
  await openApp(page)
  await page.evaluate(() => {
    const w = (window as any).__aluframe
    w.store.getState().loadDocument({ profiles: [], panels: [], fittings: [], throughRule: 'rails', connectors: [
      { id: 'first', type: 'bracket', series: 20, position: [0, 80, 0], quaternion: [0, 0, 0, 1] },
      { id: 'second', type: 'bracket', series: 20, position: [100, 80, 0], quaternion: [0, 0, 0, 1] },
    ] })
    w.tool.setState({ showDimensionLabels: false })
  })
  await setView(page, [160, 180, 240], [50, 80, 0])
  const drawn = () => page.evaluate(() => {
    const w = (window as any).__aluframe, parts: Record<string, { color: string; x: number }> = {}
    w.sceneRoot.updateMatrixWorld(true)
    w.sceneRoot.traverse((mesh: any) => {
      if (!mesh.isInstancedMesh) return
      mesh.userData.partIds.forEach((id: string, i: number) => {
        const matrix = new w.THREE.Matrix4()
        mesh.getMatrixAt(i, matrix)
        matrix.premultiply(mesh.matrixWorld)
        parts[id] = { color: mesh.material.color.getHexString(), x: matrix.elements[12] }
      })
    })
    return parts
  })
  await expect.poll(drawn).toEqual({ first: { color: '94a3b8', x: 0 }, second: { color: '94a3b8', x: 100 } })
  await page.evaluate(() => (window as any).__aluframe.tool.getState().setHoverPart('second'))
  await expect.poll(async () => (await drawn()).second.color).toBe('fbbf24')
  await page.evaluate(() => (window as any).__aluframe.store.getState().selectItems(['second']))
  await expect.poll(async () => (await drawn()).second.color).toBe('60a5fa')
  await page.getByTestId('sidebar-tab-objects').click()
  await page.locator('.object-actions button').nth(1).click()
  await expect.poll(async () => Object.keys(await drawn())).toEqual(['first'])
  await page.locator('.object-actions button').nth(3).click()
  await expect.poll(async () => Object.keys(await drawn()).sort()).toEqual(['first', 'second'])
  await page.getByTestId('object-row').filter({ hasText: 'C-second' }).getByRole('button').first().click()
  await page.evaluate(() => (document.activeElement as HTMLElement)?.blur())
  await page.keyboard.press('ArrowRight')
  await expect.poll(async () => (await drawn()).second.x).not.toBe(100)
  await page.keyboard.press('Control+z')
  await expect.poll(async () => (await drawn()).second.x).toBe(100)
  await page.keyboard.press('Delete')
  await expect.poll(async () => Object.keys(await drawn())).toEqual(['first'])
  await page.keyboard.press('Control+z')
  await expect.poll(async () => Object.keys(await drawn()).sort()).toEqual(['first', 'second'])
})
