import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { config } from 'dotenv';

config({ path: '.env.test.local' });
process.env.DATABASE_URL ??= 'postgresql://postgres@localhost:55432/zetix_test';

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
    alias: {
      'server-only': fileURLToPath(new URL('../tests/helpers/server-only-stub.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    setupFiles: ['tests/helpers/setup.ts'],
    include: ['qa/probes/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 60_000,
  },
});
