import { test, expect } from '@playwright/test'
import { openApp, settle, store, setView } from './helpers'

const UP = [-0.7071067811865475, 0, 0, 0.7071067811865476]
const ALONG_X = [0, 0.7071067811865475, 0, 0.7071067811865476]

async function corner(page: import('@playwright/test').Page) {
  await page.evaluate(([up, ax]) => {
    ;(window as any).__aluframe.store.getState().loadDocument({
      profiles: [
        { id: 'post', spec: '2020', length: 300, position: [0, 0, 0], quaternion: up, miterCuts: [], holes: [] },
        { id: 'rail', spec: '2020', length: 300, position: [0, 300, 0], quaternion: ax, miterCuts: [], holes: [] },
      ], connectors: [], panels: [], fittings: [],
    })
  }, [UP, ALONG_X])
  await settle(page)
}

const conflicts = (page: import('@playwright/test').Page) =>
  page.evaluate(() => (window as any).__aluframe.conflicts().conflicts as Array<{ a: string; b: string; depth: number }>)

/**
 * A bracket buried in a member is as much a thing that cannot be built as two members running
 * through each other — and easier to draw by accident, because a twenty-millimetre part inside
 * a rail is invisible.
 */
test.describe('A connector in the way is reported', () => {
  test.beforeEach(async ({ page }) => {
    await openApp(page)
    await corner(page)
    await setView(page, [500, 500, 500], [50, 250, 0])
  })

  test('one fitted properly is not a conflict', async ({ page }) => {
    await page.getByTestId('connector-bracket').click()
    await page.getByTestId('auto-connect').click()
    await settle(page)
    await page.waitForTimeout(300)
    expect((await store(page)).connectors.length).toBeGreaterThan(0)
    expect(await conflicts(page)).toEqual([])
  })

  test('one sunk into a member is', async ({ page }) => {
    await page.getByTestId('connector-bracket').click()
    await page.getByTestId('auto-connect').click()
    await settle(page)
    await page.waitForTimeout(300)
    await page.evaluate(() => {
      const s = (window as any).__aluframe.store.getState()
      s.addConnector({ ...s.connectors[0], id: 'buried', position: [150, 300, 0] })
    })
    await settle(page)
    await page.waitForTimeout(300)
    const c = await conflicts(page)
    expect(c.length).toBeGreaterThan(0)
    expect(c.some((x) => x.a === 'buried' || x.b === 'buried')).toBe(true)
    await expect(page.getByTestId('bom-penetrations')).toContainText(/\d/)
  })

  test('two on top of each other are', async ({ page }) => {
    await page.getByTestId('connector-bracket').click()
    await page.getByTestId('auto-connect').click()
    await settle(page)
    await page.waitForTimeout(300)
    const before = (await conflicts(page)).length
    await page.evaluate(() => {
      const s = (window as any).__aluframe.store.getState()
      s.addConnector({ ...s.connectors[0], id: 'double' })
    })
    await settle(page)
    await page.waitForTimeout(300)
    expect((await conflicts(page)).length).toBeGreaterThan(before)
  })

  test('the conflict line selects them, so they can be found', async ({ page }) => {
    await page.getByTestId('connector-bracket').click()
    await page.getByTestId('auto-connect').click()
    await settle(page)
    await page.evaluate(() => {
      const s = (window as any).__aluframe.store.getState()
      s.addConnector({ ...s.connectors[0], id: 'buried', position: [150, 300, 0] })
    })
    await settle(page)
    await page.waitForTimeout(300)
    await page.getByTestId('bom-penetrations').click()
    await settle(page)
    expect((await store(page)).selectedIds).toContain('buried')
  })
})

/** A number on the drawing that does not say which field it is sends you counting axes */
test.describe('A board and a drawer say their size on the drawing', () => {
  test.beforeEach(async ({ page }) => {
    await openApp(page)
    await page.evaluate(([up]) => {
      ;(window as any).__aluframe.store.getState().loadDocument({
        profiles: [
          { id: 'u1', spec: '2020', length: 800, position: [0, 0, 0], quaternion: up, miterCuts: [], holes: [] },
          { id: 'u2', spec: '2020', length: 800, position: [600, 0, 0], quaternion: up, miterCuts: [], holes: [] },
          { id: 'u3', spec: '2020', length: 800, position: [0, 0, 600], quaternion: up, miterCuts: [], holes: [] },
          { id: 'u4', spec: '2020', length: 800, position: [600, 0, 600], quaternion: up, miterCuts: [], holes: [] },
        ],
        connectors: [],
        panels: [{ id: 'b1', width: 560, height: 350, thickness: 18, position: [300, 400, 300], quaternion: [0, 0, 0, 1], material: 'mdf' }],
        fittings: [],
      })
    }, [UP])
    await settle(page)
    await setView(page, [1400, 900, 1600], [300, 400, 300])
  })

  test('a board is labelled with the same letters its fields use', async ({ page }) => {
    await page.evaluate(() => (window as any).__aluframe.store.getState().selectItem('b1', false))
    await settle(page)
    const fields = await page.getByTestId('panel-props').locator('input[type=number]')
      .evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value))
    expect(fields.slice(0, 3)).toEqual(['560', '350', '18'])
  })

  test('a drawer has fields of its own, in the same order', async ({ page }) => {
    await page.evaluate(() => (window as any).__aluframe.store.getState().selectItems(['u1', 'u2', 'u3', 'u4']))
    await settle(page)
    await page.getByTestId('drawer-height').fill('250')
    await page.getByTestId('add-drawer').click()
    await settle(page)
    await page.waitForTimeout(300)
    const f = (await store(page)).fittings[0]
    await page.evaluate((id) => (window as any).__aluframe.store.getState().selectItem(id, false), f.id)
    await settle(page)
    await expect(page.getByTestId('fitting-props')).toBeVisible()
    const fields = await page.getByTestId('fitting-props').locator('input[type=number]')
      .evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value))
    expect(fields).toEqual([String(Math.round(f.width)), String(Math.round(f.height)), String(Math.round(f.depth))])
  })

  test('the labels go away with the ruler, like every other dimension', async ({ page }) => {
    const on = await page.evaluate(() => (window as any).__aluframe.spriteCount())
    await page.getByTestId('labels-toggle').click()
    await settle(page)
    await page.waitForTimeout(200)
    const off = await page.evaluate(() => (window as any).__aluframe.spriteCount())
    expect(off).toBeLessThan(on)
  })

  test('a drawer can be opened from its own panel while looking', async ({ page }) => {
    await page.evaluate(() => (window as any).__aluframe.store.getState().selectItems(['u1', 'u2', 'u3', 'u4']))
    await settle(page)
    await page.getByTestId('add-drawer').click()
    await settle(page)
    await page.waitForTimeout(300)
    const f = (await store(page)).fittings[0]
    await page.evaluate((id) => (window as any).__aluframe.store.getState().selectItem(id, false), f.id)
    await settle(page)
    await page.getByTestId('fitting-open').fill('100')
    await settle(page)
    await page.waitForTimeout(200)
    expect((await store(page)).fittings[0].open).toBeCloseTo(1, 2)
  })
})

/**
 * A part is where it is. An open door is out in the room, not in the hole it came out of,
 * and a shelf seen edge-on is still a shelf you can see.
 */
test.describe('Clicking a part where it actually is', () => {
  test.beforeEach(async ({ page }) => {
    await openApp(page)
    await page.evaluate(([up]) => {
      ;(window as any).__aluframe.store.getState().loadDocument({
        profiles: [
          { id: 'u1', spec: '2020', length: 800, position: [0, 0, 0], quaternion: up, miterCuts: [], holes: [] },
          { id: 'u2', spec: '2020', length: 800, position: [600, 0, 0], quaternion: up, miterCuts: [], holes: [] },
        ],
        connectors: [],
        panels: [{ id: 'shelf', width: 560, height: 560, thickness: 18, position: [300, 400, 300],
          quaternion: [0.7071067811865476, 0, 0, 0.7071067811865476], material: 'mdf' }],
        fittings: [{ id: 'door', kind: 'door', position: [300, 400, 0], quaternion: [0, 0, 0, 1],
          width: 580, height: 760, depth: 600, material: 'mdf', open: 0,
          hinge: 'left', hingeType: 'cup', overlay: 'full', swing: 110 }],
      })
    }, [UP])
    await settle(page)
  })

  const pickAt = (page: import('@playwright/test').Page, p: number[]) => page.evaluate(async (pt) => {
    const w = (window as any).__aluframe
    const c = w.worldToClient(pt[0], pt[1], pt[2])
    return w.pickAt(c.x, c.y).map((h: { kind: string; id: string }) => h.id)
  }, p)

  const leafCentre = (page: import('@playwright/test').Page) => page.evaluate(() => {
    const w = (window as any).__aluframe
    const f = w.store.getState().fittings[0]
    return w.leafObb(f, f.open ?? 0).center.toArray()
  })

  test('an open door is selected where it swung to', async ({ page }) => {
    await page.evaluate(() => (window as any).__aluframe.store.getState().updateFitting('door', { open: 1 }, false))
    await page.waitForTimeout(1200)
    const leaf = await leafCentre(page)
    await setView(page, [leaf[0] + 900, leaf[1] + 500, leaf[2] + 1200], leaf as [number, number, number])
    await page.waitForTimeout(200)
    expect(await pickAt(page, leaf)).toContain('door')
  })

  test('...and not in the hole it came out of', async ({ page }) => {
    await page.evaluate(() => (window as any).__aluframe.store.getState().updateFitting('door', { open: 1 }, false))
    await page.waitForTimeout(1200)
    const leaf = await leafCentre(page)
    await setView(page, [leaf[0] + 900, leaf[1] + 500, leaf[2] + 1200], leaf as [number, number, number])
    await page.waitForTimeout(200)
    expect(await pickAt(page, [300, 400, 0])).not.toContain('door')
  })

  test('a shut door is selected where it sits', async ({ page }) => {
    await setView(page, [900, 900, 1400], [300, 400, 0])
    await page.waitForTimeout(200)
    expect(await pickAt(page, [300, 400, 0])).toContain('door')
  })

  test('a shelf can be clicked wherever it is drawn, from any angle', async ({ page }) => {
    // The promise is not "the shelf always wins" — a closed door in front of it should win,
    // and does. It is that wherever the renderer draws the shelf, clicking there selects it.
    for (const dy of [900, 400, 60, -300]) {
      await setView(page, [800, 400 + dy, 1400], [300, 400, 300])
      await page.waitForTimeout(250)
      const found = await page.evaluate(() => {
        const w = (window as any).__aluframe
        const r = document.querySelector('canvas')!.getBoundingClientRect()
        for (let y = r.top + 20; y < r.bottom - 20; y += 11) {
          for (let x = r.left + 20; x < r.right - 20; x += 11) {
            if (w.frontmostAt(x, y)?.id === 'shelf') return w.pickAt(x, y)[0]?.id ?? null
          }
        }
        return 'not drawn'
      })
      expect(found).toBe('shelf')
    }
  })

  test('a drawer pulled out is selected where it is', async ({ page }) => {
    await page.evaluate(() => {
      const s = (window as any).__aluframe.store.getState()
      s.loadDocument({
        profiles: s.profiles, connectors: [], panels: [],
        fittings: [{ id: 'dr', kind: 'drawer', position: [300, 200, 300], quaternion: [0, 0, 0, 1],
          width: 580, height: 250, depth: 580, material: 'ply', open: 0 }],
      })
    })
    await settle(page)
    await page.evaluate(() => (window as any).__aluframe.store.getState().updateFitting('dr', { open: 1 }, false))
    await page.waitForTimeout(1200)
    const out = await page.evaluate(() => {
      const w = (window as any).__aluframe
      return w.fittingObb(w.store.getState().fittings[0]).center.toArray()
    })
    await setView(page, [out[0] + 900, out[1] + 600, out[2] + 1200], out as [number, number, number])
    await page.waitForTimeout(200)
    expect(await pickAt(page, out)).toContain('dr')
  })
})
