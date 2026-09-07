// QA-only vitest config. Keeps the reviewer's probes out of `pnpm test`.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { config } from 'dotenv';

config({ path: '.env.test.local' });
config({ path: '.env.local' });
process.env.DATABASE_URL ??= 'postgresql://postgres@localhost:55432/zetix_qa';

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
    alias: {
      'server-only': fileURLToPath(
        new URL('../tests/helpers/server-only-stub.ts', import.meta.url),
      ),
      '@': fileURLToPath(new URL('../src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    setupFiles: ['tests/helpers/setup.ts'],
    include: ['qa/backend/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 60_000,
  },
});
