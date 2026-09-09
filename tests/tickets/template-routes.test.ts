import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, sql } from '../helpers/db';
import {
  createConcert,
  createRegistration,
  createSegment,
  createShow,
  seedAttendees,
} from '../helpers/fixtures';

/**
 * Do the editor's routes and actions **call** their guards?
 *
 * The same question `tests/auth/route-guards.test.ts` asks of `F2`'s routes and
 * `tests/tickets/ticket-actions.test.ts` asks of `D`'s. Module `D`'s QA pass
 * found both of its Server Action guards untested — making them unreachable
 * left the suite green — and this module adds three routes and three actions,
 * every one of which handles attendee names.
 *
 * The upload route is the sharpest of them: without its check, any signed-in
 * operator could write files into the concert's asset store.
 */

class RedirectSignal extends Error {
  constructor(readonly to: string) {
    super(`redirect:${to}`);
  }
}

vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new RedirectSignal(to);
  },
  notFound: () => {
    throw new Error('notFound');
  },
}));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

const sessionUser = vi.fn();
vi.mock('@/lib/auth/session', () => ({
  getSessionUser: () => sessionUser(),
  recordLogin: async () => {},
}));

const { POST: uploadAsset } = await import('@/app/api/ticket-assets/route');
const { GET: serveAsset } = await import('@/app/api/ticket-assets/[...path]/route');
const { POST: previewTicket } = await import('@/app/api/tickets/preview/route');
const { duplicateTemplateAction, saveTemplateAction, setDefaultTemplateAction } = await import(
  '@/app/(admin)/admin/concerts/[concertId]/tickets/templates/actions'
);
const { ensureConcertTemplates } = await import('@/lib/tickets/seed-templates');
const { listTemplates, loadTemplate } = await import('@/lib/tickets/templates');
const { putAsset } = await import('@/lib/tickets/assets');

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

let concertId: number;
let showId: number;
let templateId: number;

beforeAll(async () => {
  process.env.TICKET_ASSET_DIR = await mkdtemp(join(tmpdir(), 'zetix-route-assets-'));
  process.env.APP_URL ??= 'https://zetix.vercel.app';
});

beforeEach(async () => {
  await resetDb();
  sessionUser.mockReset();

  concertId = await createConcert('Routes');
  showId = await createShow(concertId, 100);
  const segmentId = await createSegment(showId, { capacity: 50, audienceMode: 'PUBLIC' });
  const registrationId = await createRegistration({ showId, segmentId });
  await seedAttendees({
    registrationId,
    showId,
    segmentId,
    count: 2,
    allocationType: 'BASE',
  });

  await ensureConcertTemplates(concertId);
  templateId = (await listTemplates(concertId))[0].id;
});

async function asRole(role: 'ADMIN' | 'OPERATOR') {
  const id = randomUUID();
  await sql`
    insert into app_users (id, email, display_name, role)
    values (${id}::uuid, ${`${role}-${id}@example.test`}, ${role}, ${role})
  `;
  sessionUser.mockResolvedValue({ id, email: 'x@y', displayName: role, role });
}

function uploadRequest(bytes: Uint8Array, filename = 'art.png', type = 'image/png') {
  const body = new FormData();
  body.set('concertId', String(concertId));
  body.set('file', new File([bytes as BufferSource], filename, { type }));
  return new Request('http://test/api/ticket-assets', { method: 'POST', body });
}

async function previewRequest(layout: unknown) {
  return new Request('http://test/api/tickets/preview', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ concertId, showId, subject: 'FIRST', layout }),
  });
}

describe('POST /api/ticket-assets', () => {
  it('accepts artwork from an admin', async () => {
    await asRole('ADMIN');
    const response = await uploadAsset(uploadRequest(PNG));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      contentType: 'image/png',
      kind: 'IMAGE',
      path: expect.stringContaining(`concerts/${concertId}/`),
    });
  });

  it('turns away an operator', async () => {
    // The probe that would otherwise stay green: any signed-in operator writing
    // files into the concert's store.
    await asRole('OPERATOR');
    expect((await uploadAsset(uploadRequest(PNG))).status).toBe(403);
  });

  it('turns away a visitor with no session', async () => {
    sessionUser.mockResolvedValue(null);
    expect((await uploadAsset(uploadRequest(PNG))).status).toBe(401);
  });

  it('refuses a file whose bytes are not artwork, however it is named', async () => {
    await asRole('ADMIN');
    const text = new TextEncoder().encode('this is not a png');
    const response = await uploadAsset(uploadRequest(text, 'art.png', 'image/png'));
    expect(response.status).toBe(415);
  });

  it('refuses an upload with no concert', async () => {
    await asRole('ADMIN');
    const body = new FormData();
    body.set('file', new File([PNG as BufferSource], 'a.png', { type: 'image/png' }));
    const response = await uploadAsset(
      new Request('http://test/api/ticket-assets', { method: 'POST', body }),
    );
    expect(response.status).toBe(400);
  });
});

describe('GET /api/ticket-assets/{path}', () => {
  it('serves artwork to an admin', async () => {
    const path = await putAsset({ concertId, contentType: 'image/png', bytes: PNG });
    await asRole('ADMIN');
    const response = await serveAsset(new Request('http://test'), {
      params: Promise.resolve({ path: path.split('/') }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    // Artwork is not public, so only the viewer's own browser may keep it.
    expect(response.headers.get('cache-control')).toContain('private');
  });

  it('answers 404 to an operator, and to no session at all', async () => {
    const path = await putAsset({ concertId, contentType: 'image/png', bytes: PNG });
    const params = { params: Promise.resolve({ path: path.split('/') }) };

    await asRole('OPERATOR');
    expect((await serveAsset(new Request('http://test'), params)).status).toBe(404);

    sessionUser.mockResolvedValue(null);
    expect((await serveAsset(new Request('http://test'), params)).status).toBe(404);
  });

  it('answers 404 rather than 500 to a path climbing out of the store', async () => {
    await asRole('ADMIN');
    const response = await serveAsset(new Request('http://test'), {
      params: Promise.resolve({ path: ['..', '..', 'etc', 'passwd.png'] }),
    });
    expect(response.status).toBe(404);
  });
});

describe('POST /api/tickets/preview', () => {
  const layout = {
    canvas: { width_pt: 200, height_pt: 100, dpi: 300 },
    elements: [
      {
        id: 'el_name',
        type: 'TEXT',
        binding: 'attendee.full_name',
        x: 10,
        y: 10,
        w: 180,
        h: 20,
      },
    ],
  };

  it('renders an unsaved layout for an admin, and reports nothing clipped', async () => {
    await asRole('ADMIN');
    const response = await previewTicket(await previewRequest(layout));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/pdf');
    expect(JSON.parse(response.headers.get('x-ticket-truncated') ?? '[]')).toEqual([]);
    expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(0);
  });

  it('reports what the renderer had to clip — the longest-name check', async () => {
    await asRole('ADMIN');
    const tight = {
      ...layout,
      elements: [
        {
          ...layout.elements[0],
          w: 12,
          h: 8,
          font_size: 22,
          // CLIP, so the renderer truncates rather than shrinking, which is
          // what makes the finding reportable at all.
          overflow: 'CLIP',
        },
      ],
    };
    const response = await previewTicket(await previewRequest(tight));
    expect(JSON.parse(response.headers.get('x-ticket-truncated') ?? '[]')).toContain('el_name');
  });

  it('turns away an operator with the same 404 the ticket PDF gives', async () => {
    await asRole('OPERATOR');
    expect((await previewTicket(await previewRequest(layout))).status).toBe(404);
  });

  it('refuses a layout the renderer would not accept', async () => {
    await asRole('ADMIN');
    const response = await previewTicket(
      await previewRequest({ canvas: { width_pt: 10, height_pt: 10 }, elements: [{ id: 'x' }] }),
    );
    expect(response.status).toBe(400);
  });

  it('refuses a show from another concert', async () => {
    await asRole('ADMIN');
    const otherConcert = await createConcert('Elsewhere');
    const otherShow = await createShow(otherConcert, 10);
    const response = await previewTicket(
      new Request('http://test/api/tickets/preview', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ concertId, showId: otherShow, subject: 'FIRST', layout }),
      }),
    );
    expect(response.status).toBe(404);
  });
});

describe('the template Server Actions', () => {
  async function outcome(run: () => Promise<{ ok: boolean }>): Promise<string> {
    try {
      const result = await run();
      return result.ok ? 'allowed' : 'refused';
    } catch (error) {
      if (error instanceof RedirectSignal) return `redirect:${error.to}`;
      return `threw:${(error as Error).message}`;
    }
  }

  it('let an admin save, set a default and duplicate', async () => {
    await asRole('ADMIN');
    const template = await loadTemplate(concertId, templateId);

    expect(
      await outcome(() =>
        saveTemplateAction({
          concertId,
          templateId,
          name: template!.name,
          layout: template!.layout,
        }),
      ),
    ).toBe('allowed');
    expect(
      await outcome(() => setDefaultTemplateAction({ concertId, templateId })),
    ).toBe('allowed');
    expect(
      await outcome(() => duplicateTemplateAction({ concertId, templateId })),
    ).toBe('allowed');
  });

  it('turn away an operator, and change nothing', async () => {
    const before = await loadTemplate(concertId, templateId);
    await asRole('OPERATOR');

    for (const run of [
      () =>
        saveTemplateAction({
          concertId,
          templateId,
          name: 'Renamed by an operator',
          layout: before!.layout,
        }),
      () => setDefaultTemplateAction({ concertId, templateId }),
      () => duplicateTemplateAction({ concertId, templateId }),
    ]) {
      expect(await outcome(run)).not.toBe('allowed');
    }

    expect(await listTemplates(concertId)).toHaveLength(3);
    expect((await loadTemplate(concertId, templateId))?.name).toBe(before!.name);
  });

  it('turn away a visitor with no session', async () => {
    sessionUser.mockResolvedValue(null);
    expect(await outcome(() => duplicateTemplateAction({ concertId, templateId }))).toMatch(
      /^redirect:/,
    );
  });

  it('refuse a template belonging to another concert', async () => {
    await asRole('ADMIN');
    const otherConcert = await createConcert('Not yours');
    await ensureConcertTemplates(otherConcert);
    const theirs = (await listTemplates(otherConcert))[0];

    const result = await saveTemplateAction({
      concertId,
      templateId: theirs.id,
      name: 'Stolen',
      layout: { canvas: { width_pt: 100, height_pt: 100, dpi: 300 }, elements: [] },
    });
    expect(result.ok).toBe(false);
    expect((await loadTemplate(otherConcert, theirs.id))?.name).toBe(theirs.name);
  });
});
