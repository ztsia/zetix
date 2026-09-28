import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, sql } from '../helpers/db';
import { createConcert, createSegment, createShow, json, setSystemSetting } from '../helpers/fixtures';
import { PUBLIC_FORM } from '../forms/fixtures';
import { createRegistration } from '@/lib/registrations/mutations';

/**
 * The party update link (spec/v3.md §25.6): name guests, correct the email
 * (re-verified), give back seats with the waitlist promoted — and waitlist mode
 * on a full form.
 */

const resolveMx = vi.hoisted(() => vi.fn());
const lookup = vi.hoisted(() => vi.fn());
vi.mock('node:dns', () => ({ promises: { resolveMx, lookup } }));
const requestHeaders = vi.hoisted(() => ({ current: new Headers() }));
vi.mock('next/headers', () => ({ headers: async () => requestHeaders.current }));

const { changeEmail, giveBackSeats, loadUpdatableParty, nameGuests } = await import('@/lib/intake/party-update');
const { submitRegistration } = await import('@/app/(registration)/f/[slug]/actions');

let concertId: number;
let showId: number;
let segmentId: number;

async function partyWithToken(name: string, seats: (string | null)[], token: string) {
  const { registrationId } = await createRegistration({
    segmentId,
    contactName: name,
    contactEmail: `${name.toLowerCase().replace(/\W+/g, '.')}@example.test`,
    seats: seats.map((fullName) => ({ fullName, allocationType: 'EXTRA' as const })),
  });
  await sql`update registrations set update_token = ${token} where id = ${registrationId}`;
  return registrationId;
}

const TOKEN = 'update-token-aaaaaaaaaaaa';

beforeEach(async () => {
  await resetDb();
  vi.resetAllMocks();
  resolveMx.mockResolvedValue([{ exchange: 'mx.example.test', priority: 10 }]);
  requestHeaders.current = new Headers({ 'x-real-ip': '198.51.100.80' });
  await setSystemSetting('review.duplicate_name_similarity', 0.8);
  concertId = await createConcert();
  showId = await createShow(concertId, 100);
  segmentId = await createSegment(showId, {
    audienceMode: 'PUBLIC',
    capacity: 3,
    extrasPolicy: 'AUTO_FCFS',
    allowPartialGrant: true,
  });
});

describe('the update link', () => {
  it('loads the party by its token, and nothing for a wrong one', async () => {
    await partyWithToken('Alice Tan', ['Alice Tan', null], TOKEN);
    const party = await loadUpdatableParty(TOKEN);
    expect(party?.seats.map((s) => [s.unnamed, s.status])).toEqual([
      [false, 'CONFIRMED'],
      [true, 'CONFIRMED'],
    ]);
    expect(await loadUpdatableParty('not-a-real-token-xxxx')).toBeNull();
  });

  it('names an unnamed guest, and refuses a seat that is not the party’s', async () => {
    const id = await partyWithToken('Alice Tan', ['Alice Tan', null], TOKEN);
    const other = await partyWithToken('Bob Lim', ['Bob Lim'], 'other-token-bbbbbbbbbbbb');
    const [unnamed] = await sql<{ id: number }[]>`
      select id::int from attendees where registration_id = ${id} and name_source = 'PLACEHOLDER'
    `;
    const [stranger] = await sql<{ id: number }[]>`select id::int from attendees where registration_id = ${other}`;

    expect((await nameGuests(TOKEN, [{ attendeeId: stranger.id, fullName: 'Hijack' }])).ok).toBe(false);
    expect((await nameGuests(TOKEN, [{ attendeeId: unnamed.id, fullName: 'Cara Tan' }])).ok).toBe(true);

    const [seat] = await sql<{ full_name: string; name_source: string }[]>`
      select full_name, name_source::text from attendees where id = ${unnamed.id}
    `;
    expect(seat).toEqual({ full_name: 'Cara Tan', name_source: 'PROVIDED' });
  });

  it('gives back seats and promotes the waitlist first come first served', async () => {
    const id = await partyWithToken('Alice Tan', ['Alice Tan', 'Bob Tan', 'Cara Tan'], TOKEN);
    // The segment (3) is full: these two wait, earliest first.
    const early = await partyWithToken('Early Bird', ['Early Bird'], 'early-token-cccccccccccc');
    const late = await partyWithToken('Late Comer', ['Late Comer'], 'late-token-dddddddddddd');
    const status = async (registrationId: number) =>
      (await sql<{ status: string }[]>`select status::text from attendees where registration_id = ${registrationId}`)[0]
        .status;
    expect(await status(early)).toBe('WAITLIST');

    const seats = await sql<{ id: number }[]>`
      select id::int from attendees where registration_id = ${id} order by id
    `;
    const result = await giveBackSeats(TOKEN, [seats[2].id]);
    expect(result.ok).toBe(true);

    expect(await status(early)).toBe('CONFIRMED');
    expect(await status(late)).toBe('WAITLIST');
    const live = await sql<{ n: number }[]>`
      select count(*)::int as n from attendees where registration_id = ${id} and deleted_at is null
    `;
    expect(live[0].n).toBe(2);
  });

  it('cancels the registration when every seat is given back', async () => {
    const id = await partyWithToken('Alice Tan', ['Alice Tan'], TOKEN);
    const [seat] = await sql<{ id: number }[]>`select id::int from attendees where registration_id = ${id}`;
    expect((await giveBackSeats(TOKEN, [seat.id])).ok).toBe(true);
    const [party] = await sql<{ status: string }[]>`select status::text from registrations where id = ${id}`;
    expect(party.status).toBe('CANCELLED');
    expect(await loadUpdatableParty(TOKEN)).toBeNull();
  });

  it('changes the email, re-verifies it, and re-addresses what is waiting', async () => {
    const id = await partyWithToken('Alice Tan', ['Alice Tan'], TOKEN);
    await sql`
      insert into email_outbox (registration_id, purpose, template_key, to_email, subject, body_md, status)
      values (${id}, 'TICKETS', 'public_ticket', 'alice.tan@example.test', 's', 'b', 'DRAFT')
    `;
    const result = await changeEmail(TOKEN, 'alice.new@example.test', { addressConfirmed: false });
    expect(result.ok).toBe(true);

    const [party] = await sql<{ contact_email: string; token: boolean; verified: boolean }[]>`
      select contact_email::text, verification_token is not null as token, email_verified_at is not null as verified
        from registrations where id = ${id}
    `;
    expect(party).toEqual({ contact_email: 'alice.new@example.test', token: true, verified: false });
    const messages = await sql<{ purpose: string; to_email: string; status: string }[]>`
      select purpose::text, to_email, status::text from email_outbox where registration_id = ${id} order by id
    `;
    expect(messages).toEqual([
      { purpose: 'TICKETS', to_email: 'alice.new@example.test', status: 'DRAFT' },
      { purpose: 'VERIFICATION', to_email: 'alice.new@example.test', status: 'QUEUED' },
    ]);
  });

  it('closes once the show has started', async () => {
    await partyWithToken('Alice Tan', ['Alice Tan', null], TOKEN);
    await sql`update shows set starts_at = now() - interval '1 hour' where id = ${showId}`;
    const party = await loadUpdatableParty(TOKEN);
    expect(party?.closedReason).toBe('SHOW_STARTED');
    expect((await nameGuests(TOKEN, [])).ok).toBe(false);
  });
});

describe('waitlist mode (§25.6)', () => {
  it('takes a request on a full segment and waitlists it', async () => {
    await setSystemSetting('form.rate_limit_per_ip_per_min', 1000);
    await setSystemSetting('form.max_tickets_per_response', 4);
    await setSystemSetting('email.receipt_hold_minutes', 10);
    await partyWithToken('Alice Tan', ['A', 'B', 'C'], TOKEN);
    await sql`
      insert into registration_forms (segment_id, kind, title, slug, schema, status, waitlist_when_full)
      values (${segmentId}, 'PUBLIC', 'Autumn', 'autumn', ${json(PUBLIC_FORM)}::text::jsonb, 'OPEN', true)
    `;
    const result = await submitRegistration({
      slug: 'autumn',
      token: null,
      schemaVersion: 1,
      addressConfirmed: false,
      answers: {
        registrant: {
          kind: 'flat',
          values: { contact_name: 'Wendy Wait', contact_email: 'wendy@example.test', heard_from: '', social_handle: '' },
        },
        party: { kind: 'repeater', rows: [] },
        extras: { kind: 'flat', values: { interests: [], instrument: '', newsletter_consent: true } },
      },
    });
    expect(result.ok).toBe(true);
    const [seat] = await sql<{ status: string }[]>`
      select a.status::text from attendees a join registrations r on r.id = a.registration_id
       where r.contact_email = 'wendy@example.test'
    `;
    expect(seat.status).toBe('WAITLIST');
  });
});

describe('giving back seats keeps a waiting party whole (QA)', () => {
  it('promotes a waitlisted party only when all of it fits', async () => {
    const id = await partyWithToken('Holder', ['H1', 'H2', 'H3'], TOKEN);
    const pair = await partyWithToken('Pair', ['P1', 'P2'], 'pair-token-eeeeeeeeeeee');
    const status = async () =>
      (await sql<{ status: string }[]>`select status::text from attendees where registration_id = ${pair} order by id`).map(
        (r) => r.status,
      );
    expect(await status()).toEqual(['WAITLIST', 'WAITLIST']);
    const held = await sql<{ id: number }[]>`select id::int from attendees where registration_id = ${id} order by id`;

    await giveBackSeats(TOKEN, [held[2].id]);
    expect(await status()).toEqual(['WAITLIST', 'WAITLIST']);

    await giveBackSeats(TOKEN, [held[1].id]);
    expect(await status()).toEqual(['CONFIRMED', 'CONFIRMED']);
  });
});
