import { defineConfig, devices } from '@playwright/test'
import { BASE_URL, PORT, STORAGE_STATE } from './helpers/env'

/**
 * One backend (FakeGrbl, temp data dir) is shared by every project, and the simulated plotter is a
 * single physical resource, so the suite runs serially (workers: 1). Projects run one after another:
 * setup → desktop-chromium → mobile-webkit (→ desktop-firefox with E2E_FIREFOX=1).
 */
const firefox = process.env.E2E_FIREFOX === '1'

export default defineConfig({
  testDir: './tests',
  outputDir: './test-results',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  use: {
    baseURL: BASE_URL,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    trace: 'retain-on-failure',
    // the SPA registers /sw.js; block it so page.route() sees every request and rebuilt assets are never served stale
    serviceWorkers: 'block',
    screenshot: 'only-on-failure',
    video: 'off',
    actionTimeout: 10_000,
    navigationTimeout: 20_000,
  },
  webServer: {
    command: 'node scripts/serve.mjs',
    url: `${BASE_URL}/api/v1/system/health`,
    reuseExistingServer: process.env.E2E_REUSE === '1',
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
    gracefulShutdown: { signal: 'SIGTERM', timeout: 10_000 },
    env: { E2E_PORT: String(PORT) },
  },
  projects: [
    { name: 'setup', testMatch: /.*\.setup\.ts/, use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    {
      name: 'desktop-chromium',
      dependencies: ['setup'],
      testIgnore: /.*\.setup\.ts/,
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 }, storageState: STORAGE_STATE },
    },
    {
      name: 'mobile-webkit',
      dependencies: ['setup'],
      testIgnore: /.*\.setup\.ts/,
      use: { ...devices['iPhone 13'], storageState: STORAGE_STATE },
    },
    ...(firefox
      ? [
          {
            name: 'desktop-firefox',
            dependencies: ['setup'],
            testIgnore: /.*\.setup\.ts/,
            use: { ...devices['Desktop Firefox'], viewport: { width: 1440, height: 900 }, storageState: STORAGE_STATE },
          },
        ]
      : []),
  ],
})
