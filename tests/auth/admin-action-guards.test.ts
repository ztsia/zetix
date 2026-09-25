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
 * reading the file proves the guard is *in* it.
 *
 * **Viewers (spec/v3.md §28).** A `VIEWER` reads every admin screen and changes
 * nothing, so every action must be `requireRole('ADMIN')` — exactly, with no
 * second role — unless it is on {@link VIEWER_READS}, the short list of actions
 * that only read. The second half of this file then proves it at runtime: it
 * signs in as a viewer and calls **every** exported action, and each one must
 * refuse with the read-only error before it does anything else.
 */

const ADMIN_ROOT = 'src/app/(admin)/admin';
const GUARD = /requireRole\(/;
const ADMIN_ONLY = /requireRole\('ADMIN'\)/;

/**
 * Actions a viewer may call, each because it only reads. Adding one here is a
 * decision about who sees what: it must mask what it returns (`maskForRole`).
 */
const VIEWER_READS = new Set(['commands/actions.ts → readRunAction']);

/** `commands/actions.ts → readRunAction`: the file's folder and name, then the action. */
function readKey(file: string, action: string): string {
  return `${file.split('/').slice(-2).join('/')} → ${action}`;
}

async function actionFiles(): Promise<string[]> {
  const entries = await readdir(ADMIN_ROOT, { recursive: true, withFileTypes: true });
  // `actions.ts` and its siblings (`export-actions.ts`) — but only Server Action
  // files: `concert-row-actions.tsx` is a Client Component with the same suffix.
  const candidates = entries
    .filter((e) => e.isFile() && /(^|-)actions\.ts$/.test(e.name))
    .map((e) => join(e.parentPath, e.name));
  const files: string[] = [];
  for (const file of candidates) {
    if (/^'use server'/.test(await readFile(file, 'utf8'))) files.push(file);
  }
  return files;
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

describe('a viewer changes nothing (spec/v3.md §28)', () => {
  it("every action is requireRole('ADMIN') unless it is a listed read", async () => {
    const open: string[] = [];
    const reads: string[] = [];
    for (const file of await actionFiles()) {
      const source = await readFile(file, 'utf8');
      for (const action of exportedActions(source)) {
        const key = readKey(file, action);
        if (VIEWER_READS.has(key)) {
          reads.push(key);
          continue;
        }
        if (!ADMIN_ONLY.test(bodyOf(source, action))) open.push(`${file} → ${action}()`);
      }
    }
    expect(open).toEqual([]);
    // A stale entry would let a renamed mutation inherit a read's exemption.
    expect(reads.sort()).toEqual([...VIEWER_READS].sort());
  });
});
