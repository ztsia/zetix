import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Does **every** Server Action under `/admin` check who is calling?
 *
 * Modules `B`, `E`, `L` and others each carry a guard test for their own
 * directories. V3 adds actions in new places — the command runner's doorway
 * (`commands/actions.ts`, spec/v3.md §23.1) is reachable by name from any
 * screen and can delete data permanently — and a per-module list is a thing the
 * next module forgets to add to. This walks the whole admin tree instead, so an
 * action file is covered the day it appears.
 *
 * A source check rather than a runtime one for the reason those tests give:
 * every suite that exercises an action mocks `@/lib/auth/session`, so only
 * reading the file proves the guard is *in* it. `R` replaces `requireAdmin()`
 * with `requireRole()` (spec/v3.md §28); widen the pattern below when it does.
 */

const ADMIN_ROOT = 'src/app/(admin)/admin';
const GUARD = /require(Admin|Role)\(/;

async function actionFiles(): Promise<string[]> {
  const entries = await readdir(ADMIN_ROOT, { recursive: true, withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && /^actions\.tsx?$/.test(e.name))
    .map((e) => join(e.parentPath, e.name));
}

function exportedActions(source: string): string[] {
  return [...source.matchAll(/export\s+async\s+function\s+(\w+)/g)].map((m) => m[1]);
}

function bodyOf(source: string, name: string): string {
  const start = source.indexOf(`export async function ${name}`);
  const rest = source.slice(start + 1);
  const next = rest.search(/\nexport\s+(async\s+)?(function|const)\s/);
  return next === -1 ? rest : rest.slice(0, next);
}

describe('every Server Action under /admin', () => {
  it('sits behind an admin guard', async () => {
    const files = await actionFiles();
    expect(files.some((f) => f.includes('commands'))).toBe(true);

    const unguarded: string[] = [];
    for (const file of files) {
      const source = await readFile(file, 'utf8');
      for (const action of exportedActions(source)) {
        if (!GUARD.test(bodyOf(source, action))) unguarded.push(`${file} → ${action}()`);
      }
    }
    expect(unguarded).toEqual([]);
  });
});
