import { defineConfig, devices } from '@playwright/test';

// Chromium is preinstalled in the cloud image at PLAYWRIGHT_BROWSERS_PATH.
// Never run a bare `playwright install` — the pinned 1.56.1 matches that build.
// WebKit is the one exception and is fetched by name; see the iphone project.
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
     * **`iphone` runs the real WebKit engine, and `android` runs Chromium.**
     * That is worth the setup it costs, because WebKit reproduces the
     * divergence that decides this module: it reports `navigator.vibrate` as
     * `undefined` where Chromium reports a function, so the feature-detection
     * path an iPhone actually takes is the one exercised.
     *
     * **It is still not an iPhone.** This is WebKit built for Linux: it shares
     * JavaScriptCore and WebCore with Safari, so engine, CSS and API-surface
     * differences are real here — but the platform behaviours are not present
     * at all. Whether the ringer switch silences Web Audio, how iOS applies its
     * autoplay rules, what the URL bar does to the viewport: none of those can
     * be answered by this project, and nothing in it should be read as if they
     * were. They are settled on the ushers' own handsets through
     * `/scan/diagnostics` and the 18 Sep rehearsal (local.md §5f).
     */
    { name: 'android', use: { ...devices['Pixel 7'], browserName: 'chromium' } },
    /**
     * Needs WebKit present, which the cloud image does not ship:
     *
     *   npx playwright install webkit && npx playwright install-deps webkit
     *
     * Only ever fetch **webkit** — never a bare `playwright install`, which
     * would re-download the pinned Chromium the image already provides. CI runs
     * `pnpm test` alone and never these specs (qa/e2e/README.md), so a missing
     * WebKit costs a local QA run and never a red build.
     */
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
