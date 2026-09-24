import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  /**
   * Three at a time, and any order.
   *
   * It was one at a time because software rendering under load was thought to be flaky. It
   * is not: three hundred and ninety-one cases pass either way, and the whole suite goes from
   * twenty-five minutes to twelve and a half — on a machine that is already at 870% CPU, so
   * more workers would not buy much. Nothing was removed to get there. A suite that takes
   * half an hour is a suite that gets run less often, and three of these were left failing
   * for a whole branch because nobody was running it as a gate.
   *
   * Each test opens its own page and clears storage, so there is no shared state to protect.
   */
  fullyParallel: true,
  workers: 3,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:5174',
    viewport: { width: 1400, height: 900 },
    headless: true,
    launchOptions: { args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npx vite --port 5174 --strictPort',
    url: 'http://127.0.0.1:5174',
    reuseExistingServer: true,
    timeout: 60_000,
  },
})
