import { expect, test } from '@playwright/test'
import { openApp } from './helpers'

async function setupFiles(page: import('@playwright/test').Page) {
  await openApp(page)
  await page.evaluate(() => {
    const w = window as any
    w.__nextFile = 'A.json'
    w.__saveMode = 'ok'
    w.__writes = []
    const file = (name: string) => ({ name,
      getFile: async () => ({ text: async () => JSON.stringify({ version: 10, throughRule: 'rails', profiles: [
        { id: name, spec: '2020', length: name === 'A.json' ? 300 : 500, position: [0, 0, 0], quaternion: [0, 0, 0, 1], holes: [], miterCuts: [] },
      ], connectors: [], panels: [], fittings: [], equipment: [] }) }),
      createWritable: async () => ({
        write: async (text: string) => { if (w.__saveMode === 'failed') throw new Error('disk full'); w.__writes.push({ name, text }) },
        close: async () => {},
      }),
    })
    w.showOpenFilePicker = async () => [file(w.__nextFile)]
    w.showSaveFilePicker = async () => {
      if (w.__saveMode === 'cancel') throw new DOMException('Cancelled', 'AbortError')
      return file('Restored.json')
    }
  })
}
async function openFile(page: import('@playwright/test').Page, name: string) {
  await page.evaluate(name => { (window as any).__nextFile = name }, name)
  await page.getByTestId('file-menu').click()
  await page.getByTestId('import-project').click()
}
async function edit(page: import('@playwright/test').Page, length: number) {
  await page.evaluate(length => {
    const s = (window as any).__aluframe.store.getState()
    s.commitProfileEdit(s.profiles[0].id, { length })
  }, length)
}

test('cancel switching, keep separate drafts, restore after reload, and never undo across files', async ({ page }) => {
  await setupFiles(page)
  await openFile(page, 'A.json')
  await expect(page.getByTestId('project-dirty')).toHaveText('无未保存更改')
  await edit(page, 350)
  await openFile(page, 'B.json')
  await expect(page.getByTestId('project-switch-dialog')).toBeVisible()
  await page.getByTestId('switch-cancel').click()
  await expect(page.getByTestId('current-project-name')).toHaveText('A.json')
  await expect(page.getByTestId('project-dirty')).toHaveText('有未保存更改')
  await openFile(page, 'B.json')
  await page.getByTestId('switch-keep-draft').click()
  await expect(page.getByTestId('current-project-name')).toHaveText('B.json')
  await expect(page.getByTestId('editor-header').getByRole('button', { name: '撤销', exact: true })).toBeDisabled()
  await page.keyboard.press('Control+z')
  expect(await page.evaluate(() => (window as any).__aluframe.store.getState().profiles[0].length)).toBe(500)
  await page.reload()
  await page.getByTestId('file-menu').click()
  await page.getByTestId('restore-drafts').click()
  const drafts = page.getByTestId('project-drafts-dialog')
  await expect(drafts).toContainText('A.json')
  await drafts.getByRole('button', { name: '恢复', exact: true }).click()
  await expect(page.getByTestId('current-project-name')).toHaveText('A.json')
  expect(await page.evaluate(() => (window as any).__aluframe.store.getState().profiles[0].length)).toBe(350)
  await expect(page.getByTestId('project-dirty')).toHaveText('有未保存更改')
  await page.getByTestId('export-project').click()
  await expect(page.getByTestId('save-overwrite')).toHaveCount(0)
})

test('saving before switching writes A to A; failed and cancelled writes keep its dirty state', async ({ page }) => {
  await setupFiles(page)
  await openFile(page, 'A.json')
  await edit(page, 350)
  await openFile(page, 'B.json')
  await page.getByTestId('switch-save').click()
  await page.evaluate(() => { (window as any).__saveMode = 'failed' })
  await page.getByTestId('save-overwrite').click()
  await expect(page.getByTestId('project-save-dialog').getByRole('alert')).toContainText('保存失败')
  await expect(page.getByTestId('current-project-name')).toHaveText('A.json')
  await expect(page.getByTestId('project-dirty')).toHaveText('有未保存更改')
  await page.getByRole('button', { name: '另存为', exact: true }).click()
  await page.evaluate(() => { (window as any).__saveMode = 'cancel' })
  await page.getByTestId('save-confirm').click()
  await expect(page.getByTestId('project-save-dialog')).toBeVisible()
  await expect(page.getByTestId('project-dirty')).toHaveText('有未保存更改')
  await page.getByRole('button', { name: '原文件', exact: true }).click()
  await page.evaluate(() => { (window as any).__saveMode = 'ok' })
  await page.getByTestId('save-overwrite').click()
  await expect(page.getByTestId('current-project-name')).toHaveText('B.json')
  const writes = await page.evaluate(() => (window as any).__writes)
  expect(writes.map((entry: any) => entry.name)).toEqual(['A.json'])
  expect(JSON.parse(writes[0].text).profiles[0].length).toBe(350)
})

test('a full draft store blocks switching and leaves the current document recoverable in memory', async ({ page }) => {
  await setupFiles(page)
  await openFile(page, 'A.json')
  await edit(page, 350)
  await page.evaluate(() => {
    const original = Storage.prototype.setItem
    Storage.prototype.setItem = function (key, value) {
      if (key.startsWith('aluframe:draft:')) throw new DOMException('Full', 'QuotaExceededError')
      return original.call(this, key, value)
    }
  })
  await openFile(page, 'B.json')
  await page.getByTestId('switch-keep-draft').click()
  await expect(page.getByTestId('project-switch-dialog').getByRole('alert')).toContainText('草稿保存失败')
  await expect(page.getByTestId('current-project-name')).toHaveText('A.json')
  expect(await page.evaluate(() => (window as any).__aluframe.store.getState().profiles[0].length)).toBe(350)
})
