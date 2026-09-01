import { defineConfig, devices } from '@playwright/test';

// Chromium is preinstalled in the cloud image at PLAYWRIGHT_BROWSERS_PATH.
// Never run `playwright install` — the pinned 1.56.1 matches that build.
const PORT = Number(process.env.QA_PORT ?? 3100);
const QA_DATABASE_URL =
  process.env.QA_DATABASE_URL ?? 'postgresql://postgres@localhost:55432/zetix_qa';

export default defineConfig({
  testDir: './qa/e2e',
  outputDir: './qa-artifacts/trace',
  // The QA database is shared across the whole run and claim_seats() takes a
  // row lock. Parallel workers would let a capacity assertion pass for the
  // wrong reason, which is precisely the bug this suite exists to catch.
  workers: 1,
  fullyParallel: false,
  // A retry that goes green hides a race rather than proving one absent.
  retries: 0,
  reporter: [['list'], ['html', { outputFolder: './qa-artifacts/report', open: 'never' }]],
  use: {
    baseURL: process.env.QA_BASE_URL ?? `http://localhost:${PORT}`,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: 'off',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `pnpm dev --port ${PORT}`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: true,
    timeout: 180_000,
    env: { DATABASE_URL: QA_DATABASE_URL, DIRECT_URL: QA_DATABASE_URL },
  },
});
