import { test, expect, type BrowserContext } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { contextFor, sql, type Who } from './qa-y-helpers';

/**
 * QA, module Y — phase 4. Real HTTP against the running world, no mocks.
 * Show 4 (Autumn Evening): Wei Ling assigned, Bob not. Show 1: Wei assigned.
 */
const SHOW = 4;
const OTHER = 5; // nobody operator-assigned
const evidence: Record<string, unknown> = {};

const ctxs = {} as Record<Who, BrowserContext>;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
  test.setTimeout(300_000);
  for (const who of ['anon', 'admin', 'viewer', 'wei', 'bob'] as Who[]) ctxs[who] = await contextFor(browser, who);
  await sql`delete from check_ins where show_id in (${SHOW}, ${OTHER})`;
  await sql`delete from walk_ins`;
  await sql`insert into system_settings (key, value) values ('checkin.walk_ins_enabled', 'true'::jsonb)
            on conflict (key) do update set value = excluded.value`;
});

test.afterAll(async () => {
  writeFileSync('qa-artifacts/claude-Y-surface-fixes/backend-evidence.json', JSON.stringify(evidence, null, 2));
  for (const c of Object.values(ctxs)) await c.close();
  await sql.end();
});

const walkIn = (o: Record<string, unknown> = {}) => ({
  clientId: randomUUID(),
  headcount: 2,
  label: 'qa walk-in',
  admittedAt: new Date().toISOString(),
  deviceId: 'qa-phone',
  ...o,
});

test('authorization matrix for the four door endpoints', async () => {
  const matrix: Record<string, Record<string, number>> = {};
  for (const who of ['anon', 'admin', 'viewer', 'wei', 'bob'] as Who[]) {
    const r = ctxs[who].request;
    const row: Record<string, number> = {};
    row['GET manifest'] = (await r.get(`/api/checkin/manifest?showId=${SHOW}`)).status();
    row['GET stats'] = (await r.get(`/api/checkin/stats?showId=${SHOW}`)).status();
    row['POST walk-ins'] = (await r.post('/api/checkin/walk-ins', { data: { showId: SHOW, walkIns: [walkIn({ label: `matrix ${who}` })] } })).status();
    row['POST scan'] = (await r.post('/api/checkin/scan', {
      data: { showId: SHOW, scans: [{ attendeeId: 999999, scannedAt: new Date().toISOString(), source: 'MANUAL', deviceId: 'qa' }] },
    })).status();
    matrix[who] = row;
  }
  evidence.matrix = matrix;
  // anonymous: 401 everywhere
  expect(matrix.anon).toEqual({ 'GET manifest': 401, 'GET stats': 401, 'POST walk-ins': 401, 'POST scan': 401 });
  // admin and assigned operator: 200
  for (const who of ['admin', 'wei'] as const) {
    expect(matrix[who]).toEqual({ 'GET manifest': 200, 'GET stats': 200, 'POST walk-ins': 200, 'POST scan': 200 });
  }
  // unassigned operator: 404 everywhere, never 200
  expect(matrix.bob).toEqual({ 'GET manifest': 404, 'GET stats': 404, 'POST walk-ins': 404, 'POST scan': 404 });
  // viewer is never at the door
  expect(matrix.viewer['GET stats']).toBe(404);
  expect(matrix.viewer['POST walk-ins']).toBe(404);
  expect(matrix.viewer['POST scan']).toBe(404);
  expect(matrix.viewer['GET manifest']).not.toBe(200);
  const rows = await sql`select label from walk_ins order by id`;
  evidence.matrixWalkInRows = rows.map((r) => r.label);
  expect(rows.map((r) => r.label).sort()).toEqual(['matrix admin', 'matrix wei']);
});

test('bob gets 404 on a show that does not exist, same body as on a real one', async () => {
  const real = await ctxs.bob.request.get(`/api/checkin/manifest?showId=${SHOW}`);
  const none = await ctxs.bob.request.get('/api/checkin/manifest?showId=987654');
  const realS = await ctxs.bob.request.get(`/api/checkin/stats?showId=${SHOW}`);
  const noneS = await ctxs.bob.request.get('/api/checkin/stats?showId=987654');
  evidence.oracle = { real: [real.status(), await real.text()], none: [none.status(), await none.text()], realS: await realS.text(), noneS: await noneS.text() };
  expect(await real.text()).toBe(await none.text());
  expect(await realS.text()).toBe(await noneS.text());
});

test('manifest carries the §32.2 fields and keys every row by attendee, ticketed or not', async () => {
  const res = await ctxs.wei.request.get(`/api/checkin/manifest?showId=${SHOW}`);
  const body = await res.json();
  const a = body.attendees as Record<string, unknown>[];
  evidence.manifestSample = a.slice(0, 3);
  const db = await sql`select count(*)::int n from attendees where show_id = ${SHOW} and deleted_at is null`;
  expect(a.length).toBe(db[0].n);
  for (const k of ['attendeeId', 'hasTicket', 'checkedInAt', 'checkedInBy', 'partySize', 'segmentName', 'nameSource']) {
    expect(Object.keys(a[0])).toContain(k);
  }
  const keys = new Set(a.map((r) => r.attendeeId));
  expect(keys.size).toBe(a.length);
  const unticketed = a.filter((r) => !r.hasTicket);
  expect(unticketed.length).toBeGreaterThan(1);
  expect(unticketed.every((r) => r.qrTokenSha256 === null)).toBe(true);
  // no raw token anywhere in the payload
  const toks = await sql`select qr_token from attendees where show_id = ${SHOW} and qr_token is not null`;
  const text = JSON.stringify(body);
  for (const t of toks) expect(text).not.toContain(t.qr_token);
  // party of 4 reports partySize 4; the cancelled seat is excluded from its party count
  const lim = a.filter((r) => String(r.name).startsWith('Qa Lim'));
  expect(lim.map((r) => r.partySize)).toEqual([4, 4, 4, 4]);
});

test('scan by attendee id: no-ticket seat admitted with reason, recorded once, idempotent, first check-in surfaces in manifest', async () => {
  const [kenji] = await sql`select id from attendees where show_id = ${SHOW} and full_name = 'Kenji Sato'`;
  const scannedAt = new Date().toISOString();
  const scan = { attendeeId: Number(kenji.id), qrTokenSha256: null, scannedAt, source: 'MANUAL', deviceId: 'qa', overrideReason: 'No ticket issued' };
  const r1 = await (await ctxs.wei.request.post('/api/checkin/scan', { data: { showId: SHOW, scans: [scan] } })).json();
  const r2 = await (await ctxs.wei.request.post('/api/checkin/scan', { data: { showId: SHOW, scans: [scan] } })).json();
  evidence.noTicketScan = { r1, r2 };
  expect(r1.receipts[0].outcome).toBe('RECORDED');
  expect(r2.receipts[0].outcome).toBe('ALREADY_SYNCED');
  const rows = await sql`select override_reason, source from check_ins where attendee_id = ${kenji.id}`;
  expect(rows.length).toBe(1);
  expect(rows[0].override_reason).toBe('No ticket issued');
  const m = await (await ctxs.wei.request.get(`/api/checkin/manifest?showId=${SHOW}`)).json();
  const k = m.attendees.find((x: { attendeeId: number }) => x.attendeeId === Number(kenji.id));
  expect(k.checkedInBy).toBe('Wei Ling');
  expect(k.checkedInAt).not.toBeNull();
});

test('scan by attendee id from another show is NOT_FOUND and records nothing', async () => {
  const [other] = await sql`select id from attendees where show_id = 1 limit 1`;
  const r = await (await ctxs.wei.request.post('/api/checkin/scan', {
    data: { showId: SHOW, scans: [{ attendeeId: Number(other.id), scannedAt: new Date().toISOString(), source: 'MANUAL', deviceId: 'qa' }] },
  })).json();
  evidence.crossShowAttendee = r;
  expect(r.receipts[0].outcome).toBe('NOT_FOUND');
  const n = await sql`select count(*)::int n from check_ins where attendee_id = ${other.id}`;
  expect(n[0].n).toBe(0);
});

test('one bad row never blocks the batch (scan route)', async () => {
  const ids = await sql`select id from attendees where show_id = ${SHOW} and full_name like 'Qa Lim%' order by id`;
  const good = (i: number) => ({ attendeeId: Number(ids[i].id), scannedAt: new Date(Date.now() + i).toISOString(), source: 'ONLINE', deviceId: 'qa' });
  const res = await ctxs.wei.request.post('/api/checkin/scan', {
    data: { showId: SHOW, scans: [good(0), { garbage: true }, { attendeeId: 'x' }, { qrTokenSha256: 'zz', scannedAt: 'nope' }, good(1), { attendeeId: Number(ids[2].id), scannedAt: '9999-99-99T00:00:00Z', source: 'ONLINE', deviceId: 'qa' }] },
  });
  const body = await res.json();
  evidence.badRowBatch = { status: res.status(), body };
  expect(res.status()).toBe(200);
  expect(body.receipts.map((r: { outcome: string }) => r.outcome)).toEqual(['RECORDED', 'REFUSED', 'REFUSED', 'REFUSED', 'RECORDED', 'REFUSED']);
});

test('scan route hostile inputs return structured errors, never 500', async () => {
  const out: Record<string, unknown> = {};
  const cases: Record<string, unknown> = {
    empty: {},
    showIdString: { showId: '4', scans: [] },
    hugeShow: { showId: 1e20, scans: [{}] },
    notJson: 'not json',
    sqlish: { showId: SHOW, scans: [{ attendeeId: 1, qrTokenSha256: "'; drop table check_ins; --", scannedAt: new Date().toISOString(), source: 'ONLINE', deviceId: '../../etc/passwd' }] },
    longReason: { showId: SHOW, scans: [{ attendeeId: 1, scannedAt: new Date().toISOString(), source: 'MANUAL', deviceId: 'qa', overrideReason: 'x'.repeat(10000) }] },
    tooMany: { showId: SHOW, scans: Array.from({ length: 501 }, () => ({})) },
  };
  for (const [k, data] of Object.entries(cases)) {
    const r = await ctxs.wei.request.post('/api/checkin/scan', { data: data as object });
    out[k] = [r.status(), (await r.text()).slice(0, 200)];
    expect(r.status()).toBeLessThan(500);
  }
  evidence.scanHostile = out;
  expect((await sql`select count(*)::int n from check_ins`)[0].n).toBeGreaterThan(0); // table still there
});

test('walk-ins: validation, idempotency, cross-show replay, segment of another show', async () => {
  const r = ctxs.wei.request;
  const w = walkIn({ headcount: 3, label: 'idem' });
  const a = await (await r.post('/api/checkin/walk-ins', { data: { showId: SHOW, walkIns: [w] } })).json();
  const b = await (await r.post('/api/checkin/walk-ins', { data: { showId: SHOW, walkIns: [w] } })).json();
  // same client id replayed against the other show Wei is assigned to (show 1)
  const c = await (await r.post('/api/checkin/walk-ins', { data: { showId: 1, walkIns: [w] } })).json();
  const seg6 = walkIn({ segmentId: 7 }); // segment 7 belongs to show 5
  const d = await (await r.post('/api/checkin/walk-ins', { data: { showId: SHOW, walkIns: [seg6] } })).json();
  const ownSeg = walkIn({ segmentId: 5, headcount: 1, label: 'own segment' });
  const e = await (await r.post('/api/checkin/walk-ins', { data: { showId: SHOW, walkIns: [ownSeg] } })).json();
  evidence.walkInIdem = { a, b, c, d, e };
  expect(a.receipts[0].outcome).toBe('RECORDED');
  expect(b.receipts[0].outcome).toBe('ALREADY_SYNCED');
  expect(c.receipts[0].outcome).toBe('REFUSED');
  expect(d.receipts[0].outcome).toBe('REFUSED');
  expect(e.receipts[0].outcome).toBe('RECORDED');
  const rows = await sql`select show_id, headcount, operator_id, device_id, admitted_at, synced_at from walk_ins where client_id = ${w.clientId}`;
  expect(rows.length).toBe(1);
  expect(Number(rows[0].show_id)).toBe(SHOW);
  expect(rows[0].device_id).toBe('qa-phone');
  // decision 58: never a fabricated registration / attendee / check-in
  const fab = await sql`select (select count(*) from registrations where contact_name ilike '%walk%')::int r,
                               (select count(*) from attendees where full_name ilike '%walk%' or full_name = 'idem')::int a`;
  expect(fab[0]).toEqual({ r: 0, a: 0 });
});

test('walk-ins: with checkin.walk_in_max_headcount unset, the server applies no cap at all', async () => {
  test.fail(true, 'QA finding: an unset cap is no cap; this test is expected to fail until fixed');
  await sql`delete from system_settings where key = 'checkin.walk_in_max_headcount'`;
  const big = walkIn({ headcount: 2147483647, label: 'uncapped' });
  const res = await ctxs.wei.request.post('/api/checkin/walk-ins', { data: { showId: SHOW, walkIns: [big] } });
  const body = await res.json();
  const stats = await (await ctxs.wei.request.get(`/api/checkin/stats?showId=${SHOW}`)).text();
  evidence.uncapped = { receipts: body.receipts, statsAfter: stats.slice(0, 300) };
  // revert so the rest of the run is not polluted
  await sql`update walk_ins set reverted_at = now() where client_id = ${big.clientId}`;
  expect(body.receipts[0].outcome, 'a headcount of 2147483647 should never be recorded').toBe('REFUSED');
});

test('walk-ins: hostile and out-of-range headcounts (cap seeded at 10, as db:seed would)', async () => {
  await sql`insert into system_settings (key, value) values ('checkin.walk_in_max_headcount', '10'::jsonb)
            on conflict (key) do update set value = excluded.value`;
  const out: Record<string, unknown> = {};
  const rows = [
    walkIn({ headcount: 0 }),
    walkIn({ headcount: -3 }),
    walkIn({ headcount: 2.5 }),
    walkIn({ headcount: '3' }),
    walkIn({ headcount: 11 }),
    walkIn({ headcount: 2147483647 }),
    walkIn({ headcount: 10 }),
    walkIn({ label: 'x'.repeat(201) }),
    walkIn({ label: "Robert'); drop table walk_ins;--" }),
    walkIn({ clientId: 'not-a-uuid' }),
    walkIn({ admittedAt: 'yesterday' }),
    walkIn({ deviceId: '' }),
  ];
  const res = await ctxs.wei.request.post('/api/checkin/walk-ins', { data: { showId: SHOW, walkIns: rows } });
  const body = await res.json();
  out.status = res.status();
  out.receipts = body.receipts;
  evidence.walkInHostile = out;
  expect(res.status()).toBe(200);
  const outcomes = body.receipts.map((r: { outcome: string }) => r.outcome);
  expect(outcomes).toEqual(['REFUSED', 'REFUSED', 'REFUSED', 'REFUSED', 'REFUSED', 'REFUSED', 'RECORDED', 'REFUSED', 'RECORDED', 'REFUSED', 'REFUSED', 'REFUSED']);
  const bad = await (await ctxs.wei.request.post('/api/checkin/walk-ins', { data: { showId: SHOW, walkIns: [] } })).status();
  const notjson = await (await ctxs.wei.request.post('/api/checkin/walk-ins', { data: 'nope' })).status();
  evidence.walkInBatchShape = { empty: bad, notjson };
  expect(bad).toBe(400);
  expect(notjson).toBe(400);
});

test('stats: counts only, show-scoped, byYou per operator, walk-ins in the hall', async () => {
  // put a walk-in on show 1 too (Wei is assigned) — must not leak into show 4's figure
  await ctxs.wei.request.post('/api/checkin/walk-ins', { data: { showId: 1, walkIns: [walkIn({ headcount: 5, label: 'show-1 walkin' })] } });
  const s = await (await ctxs.wei.request.get(`/api/checkin/stats?showId=${SHOW}`)).json();
  const sa = await (await ctxs.admin.request.get(`/api/checkin/stats?showId=${SHOW}`)).json();
  const db = await sql`
    select (select coalesce(sum(headcount),0)::int from walk_ins where show_id = ${SHOW} and reverted_at is null) w,
           (select count(distinct attendee_id)::int from check_ins where show_id = ${SHOW} and reverted_at is null) t,
           (select count(*)::int from attendees where show_id = ${SHOW} and status='CONFIRMED' and deleted_at is null) c,
           (select coalesce(sum(headcount),0)::int from walk_ins where show_id = ${SHOW} and reverted_at is null and operator_id = '22222222-2222-4222-8222-222222222222') ww`;
  evidence.stats = { wei: s, admin: sa, db: db[0] };
  expect(s.walkIns).toBe(db[0].w);
  expect(s.inHall).toBe(db[0].w + db[0].t);
  expect(s.confirmed).toBe(db[0].c);
  expect(s.capacity).toBe(60);
  expect(s.byYou.walkIns).toBe(db[0].ww);
  expect(sa.byYou.walkIns).toBe(db[0].w - db[0].ww);
  expect(typeof s.asOf).toBe('string');
  const names = await sql`select full_name from attendees where show_id = ${SHOW}`;
  const txt = JSON.stringify(s);
  for (const n of names) expect(txt).not.toContain(n.full_name);
  expect(txt).not.toContain('show-1 walkin');
});

test('RLS layer: manifest_for_show() as Bob returns zero rows; walk_ins not granted to authenticated/anon', async () => {
  const bob = await sql.begin(async (tx) => {
    await tx`set local role authenticated`;
    await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: '44444444-4444-4444-8444-444444444444', role: 'authenticated' })}, true)`;
    return tx`select count(*)::int n from public.manifest_for_show(${SHOW})`;
  });
  const wei = await sql.begin(async (tx) => {
    await tx`set local role authenticated`;
    await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: '22222222-2222-4222-8222-222222222222', role: 'authenticated' })}, true)`;
    return tx`select count(*)::int n from public.manifest_for_show(${SHOW})`;
  });
  const viewer = await sql.begin(async (tx) => {
    await tx`set local role authenticated`;
    await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: '33333333-3333-4333-8333-333333333333', role: 'authenticated' })}, true)`;
    return tx`select count(*)::int n from public.manifest_for_show(${SHOW})`;
  });
  const grants = await sql`select grantee, privilege_type from information_schema.role_table_grants where table_name = 'walk_ins' and grantee in ('anon','authenticated')`;
  let direct = 'no error';
  try {
    await sql.begin(async (tx) => {
      await tx`set local role authenticated`;
      await tx`select * from walk_ins`;
    });
  } catch (e) {
    direct = String((e as Error).message);
  }
  evidence.rls = { bob: bob[0].n, wei: wei[0].n, viewer: viewer[0].n, grants, direct };
  expect(bob[0].n).toBe(0);
  expect(viewer[0].n).toBe(0);
  expect(wei[0].n).toBeGreaterThan(0);
  expect(grants).toEqual([]);
  expect(direct).toMatch(/permission denied/);
});

test('portal ticket download route: issued → PDF, others → HTML page, never JSON', async () => {
  const r = ctxs.anon.request;
  const cases: Record<string, string> = {
    issued: 'QaLimTok0000000000001A',
    waitlisted: 'QaWaitTok000000000001W',
    pending: 'QaRevwTok000000000001P',
    cancelled: 'QaCnclTok000000000001C',
    mintedNotIssued: 'QaMintTok000000000001M',
    unknownShaped: 'ZZZZZZZZZZZZZZZZZZZZZZ',
    malformed: '..%2F..%2Fetc%2Fpasswd',
  };
  const out: Record<string, unknown> = {};
  for (const [k, tok] of Object.entries(cases)) {
    const res = await r.get(`/api/portal/${tok}/ticket?download=1`);
    const ct = res.headers()['content-type'];
    const bodyText = ct.includes('pdf') ? '<pdf>' : (await res.text()).slice(0, 120);
    out[k] = { status: res.status(), ct, body: bodyText };
  }
  evidence.download = out;
  expect((out.issued as { ct: string }).ct).toContain('application/pdf');
  for (const k of ['waitlisted', 'pending', 'cancelled', 'mintedNotIssued', 'unknownShaped', 'malformed']) {
    const o = out[k] as { status: number; ct: string };
    expect(o.ct, k).toContain('text/html');
    expect(o.status, k).toBe(404);
  }
});
