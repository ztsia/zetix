import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, sql } from '../helpers/db';
import { createConcert, createSegment, createShow, json } from '../helpers/fixtures';
import { PUBLIC_FORM } from '../forms/fixtures';
import { contrastRatio, parseTheme, readableAccent, themeTokens } from '@/lib/forms/theme';

/**
 * Forms on their parents (spec/v3.md §25.6): the funnel, and per-form themes —
 * contrast checked before the colour becomes button text, and the banner
 * upload.
 */

const sessionUser = vi.fn();
vi.mock('@/lib/auth/session', () => ({ getSessionUser: () => sessionUser(), recordLogin: async () => {} }));

const { formFunnels } = await import('@/lib/intake/funnel');
const { POST: uploadBanner } = await import('@/app/api/form-banners/route');
const { GET: serveBanner } = await import('@/app/api/form-banners/[...path]/route');

const ADMIN = { id: '00000000-0000-4000-8000-0000000000aa', email: 'a@x', displayName: 'Ada', role: 'ADMIN' };

let concertId: number;
let segmentId: number;
let formId: number;

beforeEach(async () => {
  await resetDb();
  sessionUser.mockReset();
  concertId = await createConcert();
  const showId = await createShow(concertId, 100);
  segmentId = await createSegment(showId, { audienceMode: 'PUBLIC', capacity: 50, extrasPolicy: 'AUTO_FCFS' });
  const [form] = await sql<{ id: number }[]>`
    insert into registration_forms (segment_id, kind, title, slug, schema, status)
    values (${segmentId}, 'PUBLIC', 'Autumn', 'autumn', ${json(PUBLIC_FORM)}::text::jsonb, 'OPEN')
    returning id
  `;
  formId = Number(form.id);
  await sql`insert into app_users (id, email, role, is_active) values (${ADMIN.id}, ${ADMIN.email}, 'ADMIN', true)`;
});

describe('the funnel', () => {
  it('counts responses, parties, approved and sent from the pipeline', async () => {
    const party = async (approved: boolean, delivered: boolean) => {
      const [r] = await sql<{ id: number }[]>`
        insert into registrations (show_id, segment_id, source, contact_name, contact_email, status, requested_at, approved_at)
        select show_id, id, 'FORM', 'P', 'p@example.test', 'WAITLIST', now(), ${approved ? new Date().toISOString() : null}::timestamptz
          from show_segments where id = ${segmentId}
        returning id
      `;
      await sql`select claim_seats(${segmentId}, ${r.id}, '[{"full_name":"G","allocation_type":"EXTRA"}]'::jsonb)`;
      if (delivered) {
        await sql`update attendees set ticket_sent_at = now(), ticket_sent_source = 'MANUAL' where registration_id = ${r.id}`;
      }
      await sql`
        insert into form_responses (form_id, raw, form_schema, submitted_at, registration_id)
        values (${formId}, '{}', '{"blocks":[]}', now(), ${r.id})
      `;
      return Number(r.id);
    };
    await party(false, false);
    await party(true, false);
    await party(true, true);
    // An edit chain counts once.
    const [first] = await sql<{ id: number }[]>`select id from form_responses order by id limit 1`;
    await sql`
      insert into form_responses (form_id, raw, form_schema, submitted_at, supersedes_id, registration_id)
      select form_id, raw, form_schema, now(), id, registration_id from form_responses where id = ${first.id}
    `;

    const [funnel] = await formFunnels(concertId);
    expect(funnel).toMatchObject({ id: formId, segmentId, responses: 3, parties: 3, approved: 2, sent: 1 });
  });
});

describe('theme contrast', () => {
  it('keeps a dark colour with white text, and a light one with dark text', () => {
    expect(readableAccent('#1a237e')).toEqual({ accent: '#1a237e', foreground: '#ffffff', adjusted: false });
    expect(readableAccent('#ffeb3b').foreground).toBe('#111111');
  });

  it('darkens a mid-tone neither reads on until white text passes AA', () => {
    const mid = '#e91e63';
    expect(contrastRatio(mid, '#ffffff')).toBeLessThan(4.5);
    const { accent, foreground, adjusted } = readableAccent(mid);
    expect(adjusted || contrastRatio(accent, foreground) >= 4.5).toBe(true);
    expect(contrastRatio(accent, foreground)).toBeGreaterThanOrEqual(4.5);
  });

  it('sets only --form-* tokens, the override winning over the banner', () => {
    const tokens = themeTokens({ bannerPath: null, colour: '#123456', colourOverride: '#0b3d91' })!;
    expect(Object.keys(tokens).every((key) => key.startsWith('--form-'))).toBe(true);
    expect(tokens['--form-accent']).toBe('#0b3d91');
    expect(themeTokens(null)).toBeNull();
    expect(parseTheme({ bannerPath: '../../etc/passwd', colour: 'red' })).toBeNull();
  });
});

describe('the banner upload', () => {
  // A 1×1 PNG.
  const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
  const post = (colour?: string, file: Uint8Array = PNG) => {
    const body = new FormData();
    body.set('concertId', String(concertId));
    body.set('formId', String(formId));
    body.set('file', new File([new Uint8Array(file)], 'banner.png', { type: 'image/png' }));
    if (colour) body.set('colour', colour);
    return uploadBanner(new Request('http://localhost/api/form-banners', { method: 'POST', body }));
  };

  it('stores the banner and its colour, and serves it from the local backend', async () => {
    process.env.FORM_ASSET_DIR = await mkdtemp(join(tmpdir(), 'form-assets-'));
    sessionUser.mockResolvedValue(ADMIN);

    const response = await post('#336699');
    expect(response.status).toBe(200);
    const [row] = await sql<{ theme: { bannerPath: string; colour: string } }[]>`
      select theme from registration_forms where id = ${formId}
    `;
    expect(row.theme.colour).toBe('#336699');
    expect(row.theme.bannerPath).toMatch(new RegExp(`^forms/${formId}/[0-9a-f-]+\\.png$`));

    const served = await serveBanner(new Request('http://localhost'), {
      params: Promise.resolve({ path: row.theme.bannerPath.split('/') }),
    });
    expect(served.status).toBe(200);
    expect(served.headers.get('content-type')).toBe('image/png');
  });

  it('refuses a viewer, and a file that is not an image', async () => {
    process.env.FORM_ASSET_DIR = await mkdtemp(join(tmpdir(), 'form-assets-'));
    sessionUser.mockResolvedValue({ ...ADMIN, role: 'VIEWER' });
    expect((await post()).status).toBe(403);

    sessionUser.mockResolvedValue(ADMIN);
    expect((await post(undefined, new TextEncoder().encode('%PDF-1.4 not an image'))).status).toBe(415);
  });
});
