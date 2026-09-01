import { defineConfig } from 'vitest/config';

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
