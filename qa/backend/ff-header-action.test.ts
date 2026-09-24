/**
 * QA phase 4, feat/form-field-types-and-preview: saveFormHeaderAction inputs,
 * real database. Valid / missing / wrong type / out of range / hostile.
 */
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, sql } from '../../tests/helpers/db';
import { createConcert, createSegment, createShow } from '../../tests/helpers/fixtures';

vi.mock('next/navigation', () => ({
  redirect: () => { throw new Error('redirect'); },
  notFound: () => { throw new Error('notFound'); },
}));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
const sessionUser = vi.fn();
vi.mock('@/lib/auth/session', () => ({ getSessionUser: () => sessionUser(), recordLogin: async () => {} }));

const { createFormAction, saveFormHeaderAction } = await import(
  '@/app/(admin)/admin/concerts/[concertId]/forms/actions'
);
const NO = { error: null, message: null };
const fd = (v: Record<string, string>) => { const d = new FormData(); for (const [k, x] of Object.entries(v)) d.append(k, x); return d; };

async function setup() {
  const id = randomUUID();
  await sql`insert into app_users (id, email, role, is_active) values (${id}::uuid, ${`a-${id}@example.test`}, 'ADMIN', true)`;
  sessionUser.mockResolvedValue({ id, email: 'a@example.test', role: 'ADMIN' });
  const concertId = await createConcert(`C ${id.slice(0, 6)}`);
  const showId = await createShow(concertId, 50);
  const seg = await createSegment(showId, { audienceMode: 'PUBLIC', capacity: 20 });
  const created = await createFormAction(concertId, NO, fd({ kind: 'PUBLIC', parentId: String(seg), title: 'Orig' }));
  const formId = Number(created.message);
  await sql`update registration_forms set max_responses = 9, round_label = 'R1' where id = ${formId}`;
  return { concertId, formId };
}
const row = async (id: number) =>
  (await sql<{ title: string; description_md: string | null; max_responses: number; round_label: string; slug: string; status: string; schema_version: number }[]>`
    select title, description_md, max_responses, round_label, slug, status, schema_version from registration_forms where id = ${id}`)[0];

beforeEach(async () => { await resetDb(); sessionUser.mockReset(); });

describe('saveFormHeaderAction boundary', () => {
  it('valid: writes title and description only', async () => {
    const { concertId, formId } = await setup();
    const before = await row(formId);
    const r = await saveFormHeaderAction(concertId, formId, NO, fd({ title: 'New', descriptionMd: 'Hi' }));
    console.log('valid ->', JSON.stringify(r));
    const after = await row(formId);
    expect(r.error).toBeNull();
    expect(after).toMatchObject({ ...before, title: 'New', description_md: 'Hi' });
  });
  it('missing title field entirely: structured error, no write', async () => {
    const { concertId, formId } = await setup();
    const r = await saveFormHeaderAction(concertId, formId, NO, fd({ descriptionMd: 'x' }));
    console.log('missing ->', JSON.stringify(r));
    expect(typeof r.error).toBe('string');
    expect((await row(formId)).title).toBe('Orig');
  });
  it('title 301 chars: refused, no write', async () => {
    const { concertId, formId } = await setup();
    const r = await saveFormHeaderAction(concertId, formId, NO, fd({ title: 'x'.repeat(301) }));
    console.log('301 ->', JSON.stringify(r));
    expect(typeof r.error).toBe('string');
    expect((await row(formId)).title).toBe('Orig');
  });
  it('description 200k chars: refused or stored, never a throw', async () => {
    const { concertId, formId } = await setup();
    const r = await saveFormHeaderAction(concertId, formId, NO, fd({ title: 'T', descriptionMd: 'y'.repeat(200_000) }));
    console.log('200k ->', JSON.stringify(r).slice(0, 200));
    const after = await row(formId);
    console.log('200k stored length', after.description_md?.length ?? null);
  });
  it('SQL metacharacters and ../ stored verbatim', async () => {
    const { concertId, formId } = await setup();
    const hostile = `'); drop table registration_forms; -- ../../etc/passwd <img src=x onerror=alert(1)>`;
    const r = await saveFormHeaderAction(concertId, formId, NO, fd({ title: hostile, descriptionMd: hostile }));
    expect(r.error).toBeNull();
    expect((await row(formId)).title).toBe(hostile);
  });
  it('non-numeric/foreign formId: refused, nothing written', async () => {
    const { concertId, formId } = await setup();
    const r1 = await saveFormHeaderAction(concertId, 999999, NO, fd({ title: 'X' }));
    const r2 = await saveFormHeaderAction(concertId, Number.NaN, NO, fd({ title: 'X' })).catch((e) => ({ error: `THREW ${e}` }));
    console.log('999999 ->', JSON.stringify(r1), 'NaN ->', JSON.stringify(r2));
    expect(r1.error).toBe('That form no longer exists.');
    expect((await row(formId)).title).toBe('Orig');
  });
});
