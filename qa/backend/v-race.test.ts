import { it, vi } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { resetDb, sql } from '../../tests/helpers/db';
import { createConcert, createSegment, createShow, json, setSystemSetting } from '../../tests/helpers/fixtures';
import { PUBLIC_FORM } from '../../tests/forms/fixtures';
import type { FormAnswers } from '@/lib/forms/answers';

/**
 * QA module V, AC-33: real concurrency. Driven by qa/support/v-race.sh, which
 * runs this file three times — RACE_ROLE=setup, then `a` and `b` in parallel
 * processes (one getDb() connection each, so they genuinely contend).
 *
 * RACE_CASE=same-email   two submissions from one address → one party
 * RACE_CASE=last-seat    two different parties for the last seat → one seat
 */

const resolveMx = vi.hoisted(() => vi.fn(async () => [{ exchange: 'mx.example.test', priority: 10 }]));
vi.mock('node:dns', () => ({ promises: { resolveMx, lookup: vi.fn() } }));
vi.mock('next/headers', () => ({ headers: async () => new Headers({ 'x-real-ip': `198.51.100.${process.env.RACE_ROLE === 'a' ? 1 : 2}` }) }));

const STATE = process.env.RACE_STATE ?? '/tmp/v-race-state.json';
const role = process.env.RACE_ROLE ?? 'none';
const kase = process.env.RACE_CASE ?? 'same-email';

const answers = (email: string, name: string, guests: string[]): FormAnswers => ({
  registrant: { kind: 'flat', values: { contact_name: name, contact_email: email, heard_from: '', social_handle: '' } },
  party: { kind: 'repeater', rows: guests.map((full_name) => ({ full_name })) },
  extras: { kind: 'flat', values: { interests: [], instrument: '', newsletter_consent: true } },
});

it(`race role ${role}`, async () => {
  if (role === 'setup') {
    await resetDb();
    await setSystemSetting('form.rate_limit_per_ip_per_min', 10000);
    await setSystemSetting('form.max_tickets_per_response', 4);
    await setSystemSetting('email.receipt_hold_minutes', 10);
    await setSystemSetting('review.duplicate_name_similarity', 0.8);
    const concertId = await createConcert('Race');
    const showId = await createShow(concertId, 100);
    const seg = await createSegment(showId, {
      audienceMode: 'PUBLIC',
      capacity: kase === 'last-seat' ? 1 : 50,
      extrasPolicy: 'AUTO_FCFS',
      allowPartialGrant: false,
    });
    await sql`
      insert into registration_forms (segment_id, kind, title, slug, schema, status)
      values (${seg}, 'PUBLIC', 'Race', 'race', ${json(PUBLIC_FORM)}::text::jsonb, 'OPEN')`;
    writeFileSync(STATE, JSON.stringify({ showId, seg }));
    return;
  }
  const { submitRegistration } = await import('@/app/(registration)/f/[slug]/actions');
  const state = JSON.parse(readFileSync(STATE, 'utf8'));
  const email = kase === 'same-email' ? 'same@example.test' : `${role}@example.test`;
  const guests = kase === 'same-email' ? [role === 'a' ? 'Guest A' : 'Guest B'] : [];
  const result = await submitRegistration({
    slug: 'race',
    token: null,
    schemaVersion: 1,
    addressConfirmed: false,
    answers: answers(email, `Racer ${role}`, guests),
  });
  const line = `RACE ${role} ${JSON.stringify({ seg: state.seg, ok: result.ok, message: result.ok ? null : result.message })}\n`;
  writeFileSync(`${STATE}.${role}`, line);
});
