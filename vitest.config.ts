import { defineConfig } from 'vitest/config';
import { config } from 'dotenv';

// Vitest runs outside Next, and Next is what loads `.env.local` automatically.
// Without this, a local run falls back to postgres.js's default of
// localhost:5432 and fails with ECONNREFUSED. CI passes DATABASE_URL as a real
// environment variable and dotenv never overrides those, so this is a no-op
// there — as it is in the cloud container, where the file does not exist.
config({ path: '.env.local' });

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
