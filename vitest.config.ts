import { defineConfig } from 'vitest/config';
import { config } from 'dotenv';

// Vitest runs outside Next, and Next is what loads `.env.local` automatically.
// Without this, a local run falls back to postgres.js's default of
// localhost:5432 and fails with ECONNREFUSED. CI passes DATABASE_URL as a real
// environment variable and dotenv never overrides those, so this is a no-op
// there — as it is in the cloud container, where the file does not exist.
config({ path: '.env.local' });

// The session-start hook brings up the local Postgres (spec/platform.md §16.4) but
// cannot export into the shell that later runs `pnpm test`, so a fresh session
// would otherwise fail on an unset DATABASE_URL rather than on a real problem.
// CI sets both URLs explicitly, so this fallback only ever applies locally.
process.env.DATABASE_URL ??= 'postgresql://postgres@localhost:55432/zetix';

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    // claim_seats() tests run against a real local Postgres and take a row
    // lock; running files in parallel would make the concurrency assertions
    // lie about what they proved.
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
