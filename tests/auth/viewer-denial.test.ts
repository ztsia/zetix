import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

/**
 * Does a `VIEWER` really get refused by **every** Server Action? (spec/v3.md §28)
 *
 * `admin-action-guards.test.ts` proves each action's source names
 * `requireRole('ADMIN')`. That is a claim about text; this is the claim about
 * behaviour. It signs in as a viewer, imports every action file under `/admin`,
 * and calls every exported action — and each must reject with the read-only
 * error.
 *
 * The arguments are empty objects on purpose. A guard that runs first never
 * looks at them, so the only way an action gets past its first line is by doing
 * something before the guard — parsing, a lookup, a write — and that is exactly
 * the ordering bug this is here to catch. An action that throws anything else
 * (a `TypeError` from its own input handling, a database error) fails the test
 * with its name.
 *
 * `readRunAction` is the one listed read (`VIEWER_READS` in the source check),
 * and is asserted to let the viewer in.
 */

const sessionUser = vi.fn();
vi.mock('@/lib/auth/session', () => ({
  getSessionUser: () => sessionUser(),
  recordLogin: async () => {},
}));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`redirect:${to}`);
  },
  notFound: () => {
    throw new Error('notFound');
  },
}));
vi.mock('next/cache', () => ({
  revalidatePath: () => {},
  revalidateTag: () => {},
  updateTag: () => {},
  refresh: () => {},
}));

const ADMIN_ROOT = 'src/app/(admin)/admin';
const VIEWER = { id: '00000000-0000-4000-8000-0000000000bb', email: 'v@x', displayName: 'Mei', role: 'VIEWER' };
const READS = new Set(['commands/actions.ts → readRunAction']);

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

describe('a VIEWER calling any admin Server Action', () => {
  it('is refused by every mutation before it does anything', async () => {
    sessionUser.mockResolvedValue(VIEWER);
    const files = await actionFiles();
    expect(files.length).toBeGreaterThan(10);

    const outcomes: Record<string, string> = {};
    let calls = 0;
    for (const file of files) {
      const mod: Record<string, unknown> = await import(pathToFileURL(join(process.cwd(), file)).href);
      for (const [name, fn] of Object.entries(mod)) {
        if (typeof fn !== 'function') continue;
        const key = `${file.split('/').slice(-2).join('/')} → ${name}`;
        if (READS.has(key)) continue;
        calls += 1;
        try {
          await (fn as (...args: unknown[]) => Promise<unknown>)({}, {}, {}, {});
          outcomes[key] = 'ALLOWED';
        } catch (error) {
          const refused = error instanceof Error && error.name === 'ReadOnlyAccountError';
          if (!refused) outcomes[key] = error instanceof Error ? error.message : String(error);
        }
      }
    }

    expect(calls).toBeGreaterThan(50);
    // Every entry here is an action a viewer got past, or one that did work
    // before checking who was calling.
    expect(outcomes).toEqual({});
  });

  it('may read a command run', async () => {
    sessionUser.mockResolvedValue(VIEWER);
    const { readRunAction } = await import(
      '@/app/(admin)/admin/concerts/[concertId]/commands/actions'
    );
    // Malformed ids come back as a refusal *from the action*, which is how this
    // shows the guard let the viewer through to it.
    await expect(readRunAction(0, 0)).resolves.toMatchObject({ ok: false });
  });
});
