import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Does every mutation on module `B`'s screens actually check who is calling?
 *
 * A QA probe deleted **both** `requireAdmin()` calls from this module's Server
 * Actions and `pnpm test` stayed green at 768/768. The runtime behaviour was
 * right; nothing was watching it, so a regression would have shipped in
 * silence. That is the same class of bug F2's `route-guards.test.ts` and
 * `manifest-call-site.test.ts` exist for — a test that covers the function but
 * not the call site — and this is that idea applied to Server Actions.
 *
 * **Why a source check rather than a runtime one.** These actions are the
 * boundary, so the interesting question is whether the guard is *in* them, and
 * every suite that exercises them mocks `@/lib/auth/session` — which is exactly
 * how the probe survived. Reading the file is what the probe could not fool.
 *
 * It walks the directory rather than naming files, so an action added to this
 * module later is covered the day it appears instead of the day somebody
 * remembers to add it here.
 */

/**
 * Module B's directories. `recursive: false` for Audience, where module W moved
 * B's `actions.ts` (spec/v3.md §29.1): its sub-folders are other modules'
 * actions, which scope their ids in SQL rather than through an `…InConcert()`
 * helper, and the second test below reads only for the helper.
 */
const ACTION_DIRS: { dir: string; recursive: boolean }[] = [
  { dir: 'src/app/(admin)/admin/concerts/[concertId]/audience', recursive: false },
  { dir: 'src/app/(admin)/admin/concerts/[concertId]/extras-review', recursive: true },
];

async function actionFiles(): Promise<string[]> {
  const found: string[] = [];
  for (const { dir, recursive } of ACTION_DIRS) {
    let entries;
    try {
      entries = await readdir(dir, { recursive, withFileTypes: true });
    } catch {
      continue;
    }
    found.push(
      ...entries
        .filter((e) => e.isFile() && /^actions\.tsx?$/.test(e.name))
        .map((e) => join(e.parentPath ?? dir, e.name)),
    );
  }
  return found;
}

/** Exported async functions — the Server Actions a browser can reach. */
function exportedActions(source: string): string[] {
  return [...source.matchAll(/export\s+async\s+function\s+(\w+)/g)].map((m) => m[1]);
}

/**
 * The body of one exported function, to the start of the next.
 *
 * Crude on purpose: a parser would be more precise and would also be a second
 * thing to keep right. The question here is only "does this function mention
 * the guard", and brace-free scanning answers it without pretending to more.
 */
function bodyOf(source: string, name: string): string {
  const start = source.indexOf(`export async function ${name}`);
  const rest = source.slice(start + 1);
  const next = rest.search(/\nexport\s+(async\s+)?(function|const)\s/);
  return next === -1 ? rest : rest.slice(0, next);
}

describe("module B's Server Actions", () => {
  it("all sit behind requireRole('ADMIN')", async () => {
    const files = await actionFiles();
    expect(files.length).toBeGreaterThan(0);

    const unguarded: string[] = [];
    for (const file of files) {
      const source = await readFile(file, 'utf8');
      expect(source, `${file} should be a 'use server' file`).toMatch(/^'use server'/);

      for (const action of exportedActions(source)) {
        if (!/requireRole\('ADMIN'\)/.test(bodyOf(source, action))) {
          unguarded.push(`${file} → ${action}()`);
        }
      }
    }

    expect(
      unguarded,
      'Every Server Action is reachable from a browser by name. One without ' +
        "requireRole('ADMIN') is an open mutation (CLAUDE.md, spec/v3.md §28).",
    ).toEqual([]);
  });

  /**
   * The second half of the same question: an id from a request body is not
   * evidence that it belongs to the concert whose screen sent it. `requireRole`
   * says the caller may act on this console, never that this row is one of its
   * rows.
   */
  it('check that the ids they were handed belong to the concert', async () => {
    const files = await actionFiles();
    const scoped = /InConcert\(/;

    const unscoped: string[] = [];
    for (const file of files) {
      const source = await readFile(file, 'utf8');
      for (const action of exportedActions(source)) {
        const body = bodyOf(source, action);
        // Only actions that take an id beyond the concert's own need this.
        const takesForeignId = /(registrationId|attendeeId|segmentId):\s*number/.test(body);
        if (takesForeignId && !scoped.test(body)) {
          unscoped.push(`${file} → ${action}()`);
        }
      }
    }

    expect(unscoped).toEqual([]);
  });
});
