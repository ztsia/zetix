import { defineConfig } from 'vitest/config';

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
