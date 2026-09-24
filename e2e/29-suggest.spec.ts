import { test, expect, type Page } from '@playwright/test'
import { openApp, enterDraw, drawMember, setView, store, settle, w2c, type V3 } from './helpers'

const SHOTS = process.env.SUGGEST_SHOTS ?? ''

async function suggestion(page: Page): Promise<null | { key: string; rule: string; spec: string; mid: V3; index: number }> {
  return page.evaluate(() => (window as any).__aluframe.suggestion())
}
async function health(page: Page) {
  return page.evaluate(() => {
    const w = (window as any).__aluframe
    return { conflicts: w.conflicts().conflicts.length as number, unflush: w.unflush() as number, brackets: w.bracketFaults().length as number }
  })
}
async function ghostIsDrawn(page: Page): Promise<boolean> {
  return page.evaluate(() => (window as any).__aluframe.countByName('suggestion-ghost') > 0)
}
async function shot(page: Page, name: string) {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` })
}

/**
 * 建议: a person draws four members by hand, then builds the rest of the box by pressing
 * the button and clicking the green ghost — and the drawing is never worse for it.
 */
test.describe('Suggesting the next member', () => {
  test.beforeEach(async ({ page }) => {
    await openApp(page)
    await setView(page, [1600, 1300, 2000], [300, 350, 200])
  })

  test('press, look at the ghost, click it; skip; cancel; undo', async ({ page }) => {
    await enterDraw(page, '2020')
    expect(await drawMember(page, [0, 0, 0], [600, 0, 0])).toBe(1)       // front bottom rail
    expect(await drawMember(page, [0, 0, 0], [0, 0, 400])).toBe(1)       // side bottom rail
    expect(await drawMember(page, [0, 0, 0], [0, 700, 0])).toBe(1)       // front posts
    expect(await drawMember(page, [600, 0, 0], [600, 700, 0])).toBe(1)
    await page.keyboard.press('Escape')                                   // put the member down
    await settle(page)
    expect((await store(page)).profiles.length).toBe(4)

    // the button shows a ghost and a card; nothing is added yet
    await page.getByTestId('suggest-next').click()
    await settle(page)
    const a = await suggestion(page)
    expect(a).not.toBeNull()
    expect(await ghostIsDrawn(page)).toBe(true)
    await expect(page.getByTestId('suggest-card')).toBeVisible()
    await expect(page.getByTestId('suggest-card')).toContainText(a!.spec)
    expect((await store(page)).profiles.length).toBe(4)
    await shot(page, '01-first-suggestion')

    // pressing again (N does what the button does) offers a different member
    await page.mouse.move(700, 450)
    await page.keyboard.press('n')
    await settle(page)
    const b = await suggestion(page)
    expect(b).not.toBeNull()
    expect(b!.key).not.toBe(a!.key)
    expect(b!.index).toBe(2)

    // a click on empty space drops it and adds nothing
    const vp = (await page.getByTestId('viewport').boundingBox())!
    await page.mouse.click(vp.x + vp.width - 60, vp.y + vp.height - 60)
    await settle(page)
    expect(await suggestion(page)).toBeNull()
    expect(await ghostIsDrawn(page)).toBe(false)
    await expect(page.getByTestId('suggest-card')).toHaveCount(0)
    expect((await store(page)).profiles.length).toBe(4)

    // now build the box by clicking ghosts, and nothing but ghosts
    await page.getByTestId('suggest-next').click()
    await settle(page)
    let accepts = 0
    while ((await store(page)).profiles.length < 12 && accepts < 8) {
      const s = await suggestion(page)
      expect(s, `a suggestion after ${accepts} accepts`).not.toBeNull()
      const before = await health(page)
      const n = (await store(page)).profiles.length
      const at = await w2c(page, s!.mid)
      await page.mouse.move(at.x, at.y)
      await settle(page)
      if (accepts === 0) await shot(page, '02-about-to-accept')
      await page.mouse.click(at.x, at.y)
      await settle(page)
      expect((await store(page)).profiles.length).toBe(n + 1)
      const after = await health(page)
      expect(after.conflicts).toBeLessThanOrEqual(before.conflicts)
      expect(after.unflush).toBeLessThanOrEqual(before.unflush)
      expect(after.brackets).toBeLessThanOrEqual(before.brackets)
      accepts++
    }
    await shot(page, '03-box-closed')
    const done = await store(page)
    expect(done.profiles.length).toBe(12)
    expect(accepts).toBeLessThanOrEqual(8)
    expect(await health(page)).toEqual({ conflicts: 0, unflush: 0, brackets: 0 })

    // each accept was one step: Ctrl+Z takes exactly one member out
    await page.keyboard.press('Control+z')
    await settle(page)
    expect((await store(page)).profiles.length).toBe(11)
    expect(await suggestion(page)).toBeNull()
  })

  test('a click on another part drops the suggestion and selects that part', async ({ page }) => {
    await enterDraw(page, '2020')
    await drawMember(page, [0, 0, 0], [600, 0, 0])
    await drawMember(page, [0, 0, 0], [0, 700, 0])
    await drawMember(page, [600, 0, 0], [600, 700, 0])
    await page.keyboard.press('Escape')
    await page.getByTestId('suggest-next').click()
    await settle(page)
    const s = await suggestion(page)
    expect(s).not.toBeNull()
    const post = (await store(page)).profiles[1]
    const at = await w2c(page, [post.position[0], 350, post.position[2]])
    await page.mouse.click(at.x, at.y)
    await settle(page)
    expect(await suggestion(page)).toBeNull()
    expect((await store(page)).selectedIds).toEqual([post.id])
    expect((await store(page)).profiles.length).toBe(3)
  })

  test('Esc drops it, and it is not offered while looking', async ({ page }) => {
    await enterDraw(page, '2020')
    await drawMember(page, [0, 0, 0], [600, 0, 0])
    await drawMember(page, [0, 0, 0], [0, 700, 0])
    await page.keyboard.press('Escape')
    await page.getByTestId('suggest-next').click()
    await settle(page)
    expect(await suggestion(page)).not.toBeNull()
    await page.keyboard.press('Escape')
    expect(await suggestion(page)).toBeNull()
    await page.getByTestId('mode-toggle').click()
    await expect(page.getByTestId('suggest-next')).toBeDisabled()
  })

  test('a press is quick on every cabinet of the flat', async ({ page }) => {
    const fs = await import('node:fs')
    const dir = new URL('../examples/flat/', import.meta.url)
    for (const f of fs.readdirSync(dir).filter((x: string) => x.endsWith('.json'))) {
      const doc = JSON.parse(fs.readFileSync(new URL(f, dir), 'utf8'))
      const ms = await page.evaluate((d) => {
        const w = (window as any).__aluframe
        w.store.getState().loadDocument({ ...d, profiles: d.profiles.slice(0, -1) })
        w.store.getState().clearSelection()
        const r = w.suggest()
        w.store.getState().clearAll()
        return r.ms as number
      }, doc)
      expect(ms, f).toBeLessThan(50)
    }
  })
})
