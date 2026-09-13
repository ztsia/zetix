import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, sql } from '../helpers/db';
import { createConcert, createSegment, createShow, json, setSystemSetting } from '../helpers/fixtures';
import { loadFormBySlug } from '@/lib/forms/load';
import { GET } from '@/app/api/forms/[slug]/route';
import type { FormSchema } from '@/lib/forms/schema';
import { blankFormSchema } from '@/lib/forms/templates';
import { clone, PUBLIC_FORM } from './fixtures';

/**
 * `loadFormBySlug` and its HTTP face, `GET /api/forms/{slug}`
 * (spec/v2.md §8.2, §8.3, `ref.md` §7).
 *
 * The route is exercised as a real Route Handler against real Postgres, so the
 * throttle, the states and the cache headers are all proved where they actually
 * have to hold. **Route Handlers are not covered by `src/proxy.ts`** — `/api` is
 * excluded from its matcher — which makes the guard inside the handler the only
 * one there is.
 */

type FormRow = {
  slug?: string;
  schema?: FormSchema | null;
  status?: 'DRAFT' | 'OPEN' | 'CLOSED';
  opensAt?: Date | null;
  closesAt?: Date | null;
  title?: string;
  descriptionMd?: string | null;
};

/** `createConcert` derives a unique slug from the name, so each form gets its own. */
let concertCounter = 0;

async function seedForm(row: FormRow = {}) {
  const concertId = await createConcert(`Test Concert ${++concertCounter}`);
  const showId = await createShow(concertId, null);
  const segmentId = await createSegment(showId, { audienceMode: 'PUBLIC', capacity: null });
  await sql`update show_segments set max_tickets_per_response = 4 where id = ${segmentId}`;

  const [inserted] = await sql<{ id: number }[]>`
    insert into registration_forms (segment_id, title, description_md, slug, schema, status, opens_at, closes_at)
    values (
      ${segmentId},
      ${row.title ?? 'Come to the concert'},
      ${row.descriptionMd ?? null},
      ${row.slug ?? 'autumn-public'},
      ${row.schema === null ? null : json(row.schema ?? PUBLIC_FORM)}::text::jsonb,
      ${row.status ?? 'OPEN'},
      ${row.opensAt?.toISOString() ?? null},
      ${row.closesAt?.toISOString() ?? null}
    )
    returning id
  `;

  return { concertId, showId, segmentId, formId: Number(inserted.id) };
}

const call = (slug: string, ip = '198.51.100.50') =>
  GET(new Request(`http://localhost/api/forms/${slug}`, { headers: { 'x-real-ip': ip } }), {
    params: Promise.resolve({ slug }),
  });

/** A fresh IP per assertion, so one test's requests never throttle the next. */
let ipCounter = 0;
const nextIp = () => `198.51.100.${(ipCounter++ % 200) + 20}`;

describe('loadFormBySlug', () => {
  beforeEach(async () => {
    await resetDb();
    concertCounter = 0;
    await setSystemSetting('form.rate_limit_per_ip_per_min', 50);
  });

  it('loads an open form with its caps and copy resolved', async () => {
    await seedForm({ descriptionMd: 'Up to {{max_additional_guests}} guests may come with you.' });

    const form = await loadFormBySlug('autumn-public');
    expect(form.state).toBe('OPEN');
    if (form.state !== 'OPEN') throw new Error('unreachable');

    expect(form.kind).toBe('PUBLIC');
    // Total party size of 4, less the registrant, who is seat #1.
    expect(form.limits).toEqual({ party: 3 });
    expect(form.description).toBe('Up to 3 guests may come with you.');
    expect(form.copy.max_additional_guests).toBe('3');
  });

  it('takes the kind from the JSON, which is what the contract governs', async () => {
    await seedForm({ slug: 'feedback', schema: blankFormSchema('FEEDBACK') });
    const form = await loadFormBySlug('feedback');
    expect(form.state === 'OPEN' && form.kind).toBe('FEEDBACK');
  });

  it('reports one "not found" for a missing slug, a draft, and a schema that will not parse', async () => {
    await seedForm({ slug: 'draft-form', status: 'DRAFT' });

    const broken = clone(PUBLIC_FORM);
    const registrant = broken.blocks[0];
    if (!registrant || registrant.type !== 'REGISTRANT') throw new Error('bad fixture');
    // A schema that deletes the email question. It must never render.
    registrant.fields = registrant.fields.filter((f) => f.key !== 'contact_email');
    await seedForm({ slug: 'broken-form', schema: broken });

    expect(await loadFormBySlug('no-such-form')).toEqual({ state: 'NOT_FOUND' });
    expect(await loadFormBySlug('draft-form')).toEqual({ state: 'NOT_FOUND' });
    expect(await loadFormBySlug('broken-form')).toEqual({ state: 'NOT_FOUND' });
  });

  it('reports CLOSED for a closed form and for one outside its window', async () => {
    await seedForm({ slug: 'closed', status: 'CLOSED' });
    await seedForm({ slug: 'not-yet', opensAt: new Date('2030-01-01T00:00:00Z') });
    await seedForm({ slug: 'over', closesAt: new Date('2020-01-01T00:00:00Z') });

    expect((await loadFormBySlug('closed')).state).toBe('CLOSED');
    expect((await loadFormBySlug('not-yet')).state).toBe('CLOSED');
    expect((await loadFormBySlug('over')).state).toBe('CLOSED');
  });

  it('opens exactly at opens_at and closes exactly at closes_at', async () => {
    const opensAt = new Date('2026-09-01T00:00:00Z');
    const closesAt = new Date('2026-09-18T00:00:00Z');
    await seedForm({ slug: 'windowed', opensAt, closesAt });

    const at = (now: Date) => loadFormBySlug('windowed', { now });
    expect((await at(new Date(opensAt.getTime() - 1))).state).toBe('CLOSED');
    expect((await at(opensAt)).state).toBe('OPEN');
    expect((await at(new Date(closesAt.getTime() - 1))).state).toBe('OPEN');
    // The close instant is the end of the window, not the last moment inside it.
    expect((await at(closesAt)).state).toBe('CLOSED');
  });

  it('refuses to render rather than guess when the segment is unconfigured', async () => {
    const { segmentId } = await seedForm({ slug: 'unconfigured' });
    await sql`update show_segments set max_tickets_per_response = null where id = ${segmentId}`;

    const form = await loadFormBySlug('unconfigured');
    expect(form.state).toBe('NOT_CONFIGURED');
    if (form.state !== 'NOT_CONFIGURED') throw new Error('unreachable');
    expect(form.missing).toEqual(['form.max_tickets_per_response']);
  });

  it('passes baseAlreadyClaimed through to the base repeater', async () => {
    await setSystemSetting('form.extra_rows_max', 4);
    const concertId = await createConcert();
    const showId = await createShow(concertId, null);
    const segmentId = await createSegment(showId, {
      audienceMode: 'PLAYER_INVITED',
      capacity: null,
      baseQuota: 2,
    });
    await sql`
      insert into registration_forms (segment_id, title, slug, schema, status)
      values (${segmentId}, 'Players', 'players', ${json(blankFormSchema('PLAYER'))}::text::jsonb, 'OPEN')
    `;

    const fresh = await loadFormBySlug('players');
    expect(fresh.state === 'OPEN' && fresh.limits).toEqual({ base_seats: 2, extra_seats: 4 });

    const returning = await loadFormBySlug('players', { baseAlreadyClaimed: 1 });
    expect(returning.state === 'OPEN' && returning.limits).toEqual({ base_seats: 1, extra_seats: 4 });
  });
});

describe('GET /api/forms/{slug}', () => {
  beforeEach(async () => {
    await resetDb();
    concertCounter = 0;
    await setSystemSetting('form.rate_limit_per_ip_per_min', 50);
  });

  it('returns the renderer’s inputs for an open form', async () => {
    await seedForm({ descriptionMd: 'Up to {{max_additional_guests}} guests.' });

    const response = await call('autumn-public', nextIp());
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');

    const body = await response.json();
    expect(body.state).toBe('OPEN');
    expect(body.kind).toBe('PUBLIC');
    expect(body.limits).toEqual({ party: 3 });
    expect(body.description).toBe('Up to 3 guests.');
    expect(body.schema.blocks).toHaveLength(3);
  });

  it('404s a malformed slug instead of letting it reach Postgres', async () => {
    // A NUL in the path travelled intact into a parameterised query and Postgres
    // raised 22021 — a 500 with an empty body, on a public route, for something
    // that is not a slug. Found by the module's QA pass.
    for (const slug of ['\u0000', 'Autumn Public', '../../etc/passwd', 'a'.repeat(500)]) {
      const response = await call(slug, nextIp());
      expect(response.status, `slug ${JSON.stringify(slug)}`).toBe(404);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
    }
  });

  it('404s a missing slug and a draft alike', async () => {
    await seedForm({ slug: 'draft-form', status: 'DRAFT' });
    expect((await call('nope', nextIp())).status).toBe(404);
    expect((await call('draft-form', nextIp())).status).toBe(404);
  });

  it('returns the closed state at 200, because it is a state and not an error', async () => {
    await seedForm({ slug: 'closed', status: 'CLOSED', title: 'Autumn concert' });
    const response = await call('closed', nextIp());

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ state: 'CLOSED', title: 'Autumn concert' });
  });

  it('503s an unconfigured form, and does not name the setting keys', async () => {
    const { segmentId } = await seedForm({ slug: 'unconfigured' });
    await sql`update show_segments set max_tickets_per_response = null where id = ${segmentId}`;

    const response = await call('unconfigured', nextIp());
    expect(response.status).toBe(503);

    const body = await response.json();
    // Nothing is broken and it will work when someone finishes configuring it —
    // but this route is public, so the internal key stays internal.
    expect(body.error).toBe('This form is not open yet.');
    expect(JSON.stringify(body)).not.toContain('max_tickets_per_response');
  });

  it('never returns a response, an attendee, or a seat count', async () => {
    await seedForm();
    const body = JSON.stringify(await (await call('autumn-public', nextIp())).json());
    // It hands out a form's questions and nothing else — this route has no
    // authentication, so anything naming a person would be a disclosure.
    for (const forbidden of ['contact_name":"', 'attendee', 'qr_token', 'remaining', 'email_verified']) {
      expect(body).not.toContain(forbidden);
    }
  });

  it('throttles per IP and returns a real 429 with Retry-After', async () => {
    await setSystemSetting('form.rate_limit_per_ip_per_min', 2);
    await seedForm();
    const ip = nextIp();

    expect((await call('autumn-public', ip)).status).toBe(200);
    expect((await call('autumn-public', ip)).status).toBe(200);

    const throttled = await call('autumn-public', ip);
    expect(throttled.status).toBe(429);
    expect(Number(throttled.headers.get('Retry-After'))).toBeGreaterThan(0);
    expect(throttled.headers.get('Cache-Control')).toBe('no-store');

    // Someone else on another connection is unaffected.
    expect((await call('autumn-public', nextIp())).status).toBe(200);
  });

  it('throttles a miss too, so the route cannot be used to enumerate slugs', async () => {
    await setSystemSetting('form.rate_limit_per_ip_per_min', 2);
    const ip = nextIp();

    expect((await call('guess-one', ip)).status).toBe(404);
    expect((await call('guess-two', ip)).status).toBe(404);
    // The throttle runs before the lookup, so a prober is stopped by the same
    // budget a real reader spends.
    expect((await call('guess-three', ip)).status).toBe(429);
  });
});
