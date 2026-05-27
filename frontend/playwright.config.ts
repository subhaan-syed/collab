import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  expect: { timeout: 8_000 },
  fullyParallel: false,
  // Fail the build on CI if test.only is accidentally left in.
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  // Run serially — each test spins up its own WS connections and two browser
  // contexts; parallel workers would require multiple server instances.
  workers: 1,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  // Start the Vite dev server before the tests run.
  // Requires the FastAPI backend to be running separately on port 8000.
  webServer: {
    command: 'npm run dev',
    port: 5173,
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
