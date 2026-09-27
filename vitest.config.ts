import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { config } from 'dotenv';

// Vitest runs outside Next, and Next is what loads `.env.local` automatically.
// Without this, a local run falls back to postgres.js's default of
// localhost:5432 and fails with ECONNREFUSED. CI passes DATABASE_URL as a real
// environment variable and dotenv never overrides those, so this is a no-op
// there — as it is in the cloud container, where the file does not exist.
// `.env.test.local` first, deliberately. On a developer machine `.env.local`
// points DATABASE_URL at the real Supabase project (local.md §6), and
// `resetDb()` below truncates all 21 tables — so a plain `pnpm test` there
// would empty production. dotenv never overrides a variable that is already
// set, so whatever `.env.test.local` defines wins over `.env.local`, and a real
// environment variable (CI) still wins over both. `tests/helpers/db.ts` refuses
// a non-local host outright; this is what makes the local run succeed rather
// than merely fail safely.
config({ path: '.env.test.local' });
config({ path: '.env.local' });

// The session-start hook brings up the local Postgres (spec/platform.md §16.4) but
// cannot export into the shell that later runs `pnpm test`, so a fresh session
// would otherwise fail on an unset DATABASE_URL rather than on a real problem.
// CI sets both URLs explicitly, so this fallback only ever applies locally.
process.env.DATABASE_URL ??= 'postgresql://postgres@localhost:55432/zetix';

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
    alias: {
      // `server-only` throws unless the bundler picks its `react-server`
      // condition, which Vitest does not. Without this, importing any guarded
      // server module fails at import time rather than running its tests.
      // See tests/helpers/server-only-stub.ts.
      'server-only': fileURLToPath(
        new URL('./tests/helpers/server-only-stub.ts', import.meta.url),
      ),
    },
  },
  test: {
    environment: 'node',
    setupFiles: ['tests/helpers/setup.ts'],
    // `.tsx` too, so the form renderer can be asserted against its real output.
    // `tests/forms/renderer.test.tsx` renders it with `renderToStaticMarkup`,
    // which needs no DOM — see that file for why there is no jsdom here.
    include: ['src/**/*.test.ts?(x)', 'tests/**/*.test.ts?(x)'],
    // claim_seats() tests run against a real local Postgres and take a row
    // lock; running files in parallel would make the concurrency assertions
    // lie about what they proved.
    fileParallelism: false,
    testTimeout: 30_000,
    // Hooks get the same ceiling. `tests/schema/v3-migration.test.ts` drops and
    // creates a scratch database in `beforeEach`, and both force a checkpoint:
    // after a write-heavy run of earlier files that checkpoint alone can outlast
    // vitest's 10s hook default (seen waiting on `CheckpointDone`).
    hookTimeout: 30_000,
  },
});
