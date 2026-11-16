import { defineConfig } from '@playwright/test';

const port = Number(process.env.PW_PORT ?? 5173);

export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 40_000,
  expect: { timeout: 8_000 },
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    channel: process.env.PW_CHANNEL ?? 'chrome',
    headless: true,
    viewport: { width: 1440, height: 900 },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: `npm run dev -- --port ${port} --strictPort`,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: true,
  },
});
