import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Is `manifest_for_show()` what the endpoint actually calls?
 *
 * Both QA passes on this branch found the same class of bug: **a test that
 * covers the function but not the call site.** Round one broke `requireAdmin()`
 * and the suite went red; round two deleted the *call* to it from the admin
 * layout and the suite stayed green. `tests/auth/route-guards.test.ts` exists
 * because of that, and this file is the same idea one layer down.
 *
 * `tests/auth/manifest-rpc.test.ts` proves the function refuses a show the
 * caller is not rostered on. That says nothing about whether the manifest route
 * uses it. A route that reads `attendees` through Drizzle passes every one of
 * those assertions and has no second layer at all — the one real weakness of
 * the mechanism decision 20b chose, since its coverage is opt-in.
 *
 * Module `G` owns the route (modules.md §3), so it does not exist yet. This
 * test is written now, deliberately, and **turns on by itself the moment the
 * file appears** — the alternative is a note in a handoff, and a note is not a
 * gate. `eslint.config.mjs` denies the same route the imports that would let it
 * take the other path; this is the half that survives someone moving the query
 * into a helper.
 */

const MANIFEST_DIR = 'src/app/api/checkin/manifest';

/** Every Route Handler under the manifest directory, however `G` nests it. */
async function manifestRouteFiles(): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(MANIFEST_DIR, { recursive: true, withFileTypes: true });
  } catch {
    return []; // Module G has not landed yet.
  }
  return entries
    .filter((e) => e.isFile() && /^route\.(ts|tsx)$/.test(e.name))
    .map((e) => join(e.parentPath ?? MANIFEST_DIR, e.name));
}

describe('the check-in manifest route', () => {
  it('reads the roster through .rpc(manifest_for_show), never through Drizzle', async () => {
    const files = await manifestRouteFiles();

    if (files.length === 0) {
      // Module G has not landed. Nothing to assert, and nothing to hide: the
      // moment the route exists this test starts enforcing.
      expect(files).toEqual([]);
      return;
    }

    for (const file of files) {
      const source = await readFile(file, 'utf8');

      expect(
        source,
        `${file} must call manifest_for_show() — that call is the second layer decision 20 requires`,
      ).toContain('manifest_for_show');

      expect(
        source,
        `${file} must not read the roster over Drizzle; the .rpc() call is the boundary (decision 20b)`,
      ).not.toMatch(/from\s+'@\/db\/client'/);

      expect(
        source,
        `${file} must not import attendees or registrations directly (decision 20b)`,
      ).not.toMatch(/from\s+'@\/db\/schema\/registrations'/);
    }
  });
});
