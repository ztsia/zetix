import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// QA-owned backend suite. Same aliases and setup as the project's own config,
// but collecting only `qa/backend/**` so the two suites never mix.
process.env.DATABASE_URL ??= 'postgresql://postgres@localhost:55432/zetix_qa';

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
    alias: {
      'server-only': fileURLToPath(
        new URL('../../tests/helpers/server-only-stub.ts', import.meta.url),
      ),
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
