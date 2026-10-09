import { expect, test } from '@playwright/test'
import { openApp } from './helpers'

test('template parameters remain editable with one undo and explain unsafe regeneration', async ({ page }) => {
  await openApp(page)
  await page.getByTestId('template-cabinet').click()
  await page.getByTestId('template-place').click()
  await page.getByTestId('sidebar-tab-properties').click()
  await expect(page.getByTestId('template-instance-editor')).toBeVisible()
  const snapshot = () => page.evaluate(() => {
    const s = (window as any).__aluframe.store.getState()
    return { profiles: s.profiles, instances: s.templateInstances, past: s.past.length }
  })
  const before = await snapshot()
  await page.getByTestId('instance-param-w').fill('700')
  await page.getByTestId('template-instance-apply').click()
  await expect.poll(async () => (await snapshot()).instances[0].parameters.w).toBe(700)
  const after = await snapshot()
  expect(after.profiles.map((p: any) => p.id)).toEqual(before.profiles.map((p: any) => p.id))
  expect(after.past).toBe(before.past + 1)
  await page.getByRole('button', { name: '撤销', exact: true }).click()
  expect((await snapshot()).profiles).toEqual(before.profiles)
  await expect(page.getByTestId('instance-param-w')).toHaveValue(String(before.instances[0].parameters.w))
  await page.getByRole('button', { name: '重做', exact: true }).click()
  await expect(page.getByTestId('instance-param-w')).toHaveValue('700')
  await page.evaluate(() => {
    const s = (window as any).__aluframe.store.getState()
    s.commitProfileEdit(s.profiles[0].id, { length: s.profiles[0].length + 10 })
  })
  const edited = await snapshot()
  await page.getByTestId('instance-param-w').fill('750')
  await page.getByTestId('template-instance-apply').click()
  await expect(page.getByTestId('template-instance-editor').getByRole('alert')).toContainText('手动修改')
  expect(await snapshot()).toEqual(edited)
})
