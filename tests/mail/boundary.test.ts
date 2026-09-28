import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * `src/lib/mail/` imports nothing from the rest of the app (spec/v3.md §26.7),
 * so extracting it into its own package is a move, not a rewrite. This is the
 * check that keeps it true: an `@/` import, or a relative one that climbs out,
 * fails here long before anyone tries the extraction.
 */
describe('src/lib/mail stays liftable', () => {
  const dir = join(process.cwd(), 'src/lib/mail');
  const files = readdirSync(dir).filter((f) => f.endsWith('.ts'));

  it('has files to check', () => {
    expect(files.length).toBeGreaterThan(3);
  });

  it.each(files)('%s imports only packages and its own siblings', (file) => {
    const source = readFileSync(join(dir, file), 'utf8');
    const specifiers = [...source.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
    const escaping = specifiers.filter((s) => s.startsWith('@/') || s.startsWith('../'));
    expect(escaping).toEqual([]);
  });
});
