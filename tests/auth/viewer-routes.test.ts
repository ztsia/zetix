import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

/**
 * Does a `VIEWER` get refused by every Route Handler? (spec/v3.md §28)
 *
 * `viewer-denial.test.ts` covers Server Actions. Route Handlers are the other
 * way in — every export, import, PDF and upload lives behind one — and an
 * independent QA probe that let a viewer through `/api/export/xlsx` left the
 * suite green. This walks `src/app/api`, calls every exported method as a
 * viewer with an empty request, and requires a refusal.
 *
 * The request is empty on purpose, like the actions sweep's arguments: a
 * handler that checks the role first refuses it with 401/403/404 before it
 * reads anything, and one that answers 400 has parsed the body before asking
 * who is calling — the ordering bug this exists to catch.
 */

const sessionUser = vi.fn();
vi.mock('@/lib/auth/session', () => ({
  getSessionUser: () => sessionUser(),
  recordLogin: async () => {},
}));
vi.mock('next/cache', () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

const API_ROOT = 'src/app/api';
const VIEWER = { id: '00000000-0000-4000-8000-0000000000bb', email: 'v@x', displayName: 'Mei', role: 'VIEWER' };

/**
 * Routes a viewer may call, or that nobody signs in to reach.
 * Each entry is a decision about who sees what; say why beside it.
 */
const NOT_SWEPT: Record<string, string> = {
  'health/route.ts': 'public keep-alive',
  'forms/[slug]/route.ts': 'the public registration form',
  'portal/[token]/booklet/route.ts': 'a ticket holder, by token',
  'portal/[token]/ticket/route.ts': 'a ticket holder, by token',
  'ticket-assets/[...path]/route.ts GET': 'artwork for the designer a viewer reads; no attendee data',
};

async function routeFiles(): Promise<string[]> {
  const entries = await readdir(API_ROOT, { recursive: true, withFileTypes: true });
  return entries.filter((e) => e.isFile() && e.name === 'route.ts').map((e) => join(e.parentPath, e.name));
}

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

describe('a VIEWER calling any /api Route Handler', () => {
  it('is refused before the handler reads the request', async () => {
    sessionUser.mockResolvedValue(VIEWER);
    const files = await routeFiles();
    expect(files.length).toBeGreaterThan(10);

    const outcomes: Record<string, number | string> = {};
    let calls = 0;
    for (const file of files) {
      const rel = file.slice(API_ROOT.length + 1);
      if (NOT_SWEPT[rel]) continue;
      const mod: Record<string, unknown> = await import(pathToFileURL(join(process.cwd(), file)).href);
      for (const method of METHODS) {
        const handler = mod[method];
        if (typeof handler !== 'function') continue;
        if (NOT_SWEPT[`${rel} ${method}`]) continue;
        calls += 1;
        const request = new Request('http://localhost/api/x?concertId=1&showId=1&formId=1', {
          method,
          ...(method === 'GET' ? {} : { body: '{}', headers: { 'content-type': 'application/json' } }),
        });
        const context = {
          params: Promise.resolve({ path: ['x'], attendeeId: '1', token: 'x', slug: 'x' }),
        };
        try {
          const response = (await (handler as (r: Request, c: unknown) => Promise<Response>)(
            request,
            context,
          )) as Response;
          if (![401, 403, 404].includes(response.status)) outcomes[`${rel} ${method}`] = response.status;
        } catch (error) {
          outcomes[`${rel} ${method}`] = error instanceof Error ? error.message : String(error);
        }
      }
    }

    expect(calls).toBeGreaterThan(10);
    // Every entry is a route a viewer got past, or one that read the request
    // before checking who sent it.
    expect(outcomes).toEqual({});
  });
});
