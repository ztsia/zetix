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
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    /**
     * The door scanner is the one surface that is phone-only (spec/surfaces.md
     * §15.4), and the ushers carry a mix of Android and iPhone (context.md §6
     * question 7). Both shapes run, because the two differ in the ways that
     * break this screen: viewport height, safe-area insets at the bottom, and
     * how much room the tab bar has once the browser chrome is counted.
     *
     * **Both are Chromium, and that is a real limit worth stating.** Only the
     * Chromium engine is installed here, so `iphone` reproduces an iPhone's
     * *metrics*, never Safari's *behaviour* — the Vibration API it does not
     * have, the autoplay rules it applies to `AudioContext`, whether the ringer
     * switch silences Web Audio. Nothing in this suite can speak to those, and
     * nothing in it should be read as if it did. They are settled on real
     * handsets instead, through `/scan/diagnostics` and the 18 Sep rehearsal
     * (local.md §5e). What this project *does* catch is layout, thumb reach,
     * the offline queue and the manifest — which is most of the surface, and
     * all of it regressible.
     */
    { name: 'android', use: { ...devices['Pixel 7'] } },
    { name: 'iphone', use: { ...devices['iPhone 15'] } },
  ],
  webServer: {
    command: `pnpm dev --port ${PORT}`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: true,
    timeout: 180_000,
    env: { DATABASE_URL: QA_DATABASE_URL, DIRECT_URL: QA_DATABASE_URL },
  },
});
