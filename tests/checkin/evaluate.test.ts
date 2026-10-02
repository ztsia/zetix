import { describe, expect, it } from 'vitest';
import { buildManifestIndex, type ManifestEntry } from '@/lib/checkin/manifest';
import { evaluateScan, type LocalCheckIn } from '@/lib/checkin/evaluate';

/**
 * The door's decision, with no network in it (spec/checkin.md §12.1, §12.3).
 *
 * Every scan resolves against the offline manifest and this function, online or
 * off — connectivity changes only *when the row reaches the server*, never
 * whether the usher gets an answer. So these tests are the admission logic in
 * full.
 *
 * Two rules are load-bearing and easy to erode:
 *
 * - **A cancelled ticket says "refer to desk", never "not found"**
 *   (spec/allocation.md §7.9). The person is real and their seat was real; the
 *   door must not accuse them of a forgery.
 * - **Amber and red are never hard blocks** (§12.1). Nothing here returns a
 *   refusal — it returns a state, and the operator can always admit anyway.
 *   Turning away a real guest at a free concert is worse than a duplicate row.
 */

const HASH = {
  alice: 'a'.repeat(64),
  bob: 'b'.repeat(64),
  carol: 'c'.repeat(64),
  dan: 'd'.repeat(64),
  solo: 'e'.repeat(64),
  cancelled: 'f'.repeat(64),
};

function entry(over: Partial<ManifestEntry> & Pick<ManifestEntry, 'qrTokenSha256'>): ManifestEntry {
  return {
    attendeeId: null,
    hasTicket: true,
    ticketCode: 'ORC-7K4Q',
    name: 'Alice Tan',
    nameSource: 'PROVIDED',
    playerName: 'Wei Ling',
    status: 'CONFIRMED',
    registrationId: 1,
    partySize: 4,
    segmentName: null,
    checkedInAt: null,
    checkedInBy: null,
    ...over,
  };
}

/** A party of four on one registration, plus a party of one, plus a cancellation. */
const INDEX = buildManifestIndex([
  entry({ qrTokenSha256: HASH.alice, name: 'Alice Tan' }),
  entry({ qrTokenSha256: HASH.bob, name: 'Bob Tan' }),
  entry({ qrTokenSha256: HASH.carol, name: 'Carol Tan' }),
  entry({ qrTokenSha256: HASH.dan, name: 'Dan Tan' }),
  entry({
    qrTokenSha256: HASH.solo,
    name: 'Priya Nair',
    registrationId: 2,
    partySize: 1,
    playerName: null,
    ticketCode: 'ORC-9M2X',
  }),
  entry({
    qrTokenSha256: HASH.cancelled,
    name: 'Marcus Lee',
    registrationId: 3,
    partySize: 1,
    status: 'CANCELLED',
    ticketCode: 'ORC-4T8B',
  }),
]);

const none: LocalCheckIn[] = [];

describe('a ticket that should get in', () => {
  it('admits, and says who invited them', () => {
    const result = evaluateScan({ hash: HASH.alice, index: INDEX, checkIns: none });
    expect(result.outcome).toBe('ADMITTED');
    expect(result.tone).toBe('admitted');
    expect(result.entry?.name).toBe('Alice Tan');
    expect(result.entry?.playerName).toBe('Wei Ling');
  });

  it('carries party context, because only one phone comes out for a family', () => {
    // §12.1: scan one of four and three people walk in unrecorded, which makes
    // the stats tab wrong for the rest of the night — and stats is what the
    // door uses to decide when to stop holding seats.
    const result = evaluateScan({ hash: HASH.alice, index: INDEX, checkIns: none });
    expect(result.party).toEqual({ size: 4, admitted: 1, remaining: 3 });
  });

  it('offers no party control for a party of one', () => {
    const result = evaluateScan({ hash: HASH.solo, index: INDEX, checkIns: none });
    expect(result.outcome).toBe('ADMITTED');
    expect(result.party).toEqual({ size: 1, admitted: 1, remaining: 0 });
  });

  it('counts the rest of the party as they are admitted', () => {
    const checkIns: LocalCheckIn[] = [
      { key: `h${HASH.bob}`, scannedAt: '2026-09-19T11:00:00.000Z', source: 'MANUAL' },
    ];
    const result = evaluateScan({ hash: HASH.alice, index: INDEX, checkIns });
    expect(result.party).toEqual({ size: 4, admitted: 2, remaining: 2 });
  });
});

describe('a ticket that has already been through', () => {
  const checkIns: LocalCheckIn[] = [
    {
      key: `h${HASH.alice}`,
      scannedAt: '2026-09-19T11:04:00.000Z',
      source: 'ONLINE',
      operatorName: 'Sam',
    },
  ];

  it('is amber, and names the first scan so the usher can judge', () => {
    const result = evaluateScan({ hash: HASH.alice, index: INDEX, checkIns });
    expect(result.outcome).toBe('ALREADY_CHECKED_IN');
    expect(result.tone).toBe('duplicate');
    expect(result.firstScan).toEqual({ at: '2026-09-19T11:04:00.000Z', operatorName: 'Sam' });
  });

  it('is not a block — the operator can still admit', () => {
    const result = evaluateScan({ hash: HASH.alice, index: INDEX, checkIns });
    expect(result.canAdmitAnyway).toBe(true);
  });

  it('ignores a scan that was reverted', () => {
    const reverted: LocalCheckIn[] = [{ ...checkIns[0], revertedAt: '2026-09-19T11:05:00.000Z' }];
    expect(evaluateScan({ hash: HASH.alice, index: INDEX, checkIns: reverted }).outcome).toBe(
      'ADMITTED',
    );
  });

  it('reports the earliest scan when a token was read more than twice', () => {
    const twice: LocalCheckIn[] = [
      { key: `h${HASH.alice}`, scannedAt: '2026-09-19T11:09:00.000Z', source: 'ONLINE' },
      { key: `h${HASH.alice}`, scannedAt: '2026-09-19T11:04:00.000Z', source: 'ONLINE' },
    ];
    expect(evaluateScan({ hash: HASH.alice, index: INDEX, checkIns: twice }).firstScan?.at).toBe(
      '2026-09-19T11:04:00.000Z',
    );
  });
});

describe('a cancelled ticket', () => {
  it('says refer to desk, and never "not found"', () => {
    const result = evaluateScan({ hash: HASH.cancelled, index: INDEX, checkIns: none });
    expect(result.outcome).toBe('CANCELLED');
    expect(result.tone).toBe('error');
    expect(result.entry?.name).toBe('Marcus Lee');
  });

  it('outranks a duplicate, because it is the more useful thing to say', () => {
    const checkIns: LocalCheckIn[] = [
      { key: `h${HASH.cancelled}`, scannedAt: '2026-09-19T11:00:00.000Z', source: 'ONLINE' },
    ];
    expect(evaluateScan({ hash: HASH.cancelled, index: INDEX, checkIns }).outcome).toBe('CANCELLED');
  });

  it('is still admissible by hand', () => {
    const result = evaluateScan({ hash: HASH.cancelled, index: INDEX, checkIns: none });
    expect(result.canAdmitAnyway).toBe(true);
  });
});

describe('a ticket that is not in this manifest', () => {
  it('is red and invalid', () => {
    const result = evaluateScan({ hash: 'f0'.repeat(32), index: INDEX, checkIns: none });
    expect(result.outcome).toBe('NOT_FOUND');
    expect(result.tone).toBe('error');
    expect(result.entry).toBeUndefined();
  });

  it('is the same answer when the QR carried nothing token-shaped', () => {
    expect(evaluateScan({ hash: null, index: INDEX, checkIns: none }).outcome).toBe('NOT_FOUND');
  });

  it('cannot be admitted by hand, because there is no attendee to record it against', () => {
    // `check_ins.attendee_id` is NOT NULL (src/db/schema/checkin.ts). A token
    // nobody recognises has no row to write, so the honest answer is that this
    // one state has no Admit-anyway — the usher may still wave the person
    // through physically, and the system says so rather than pretending.
    expect(evaluateScan({ hash: null, index: INDEX, checkIns: none }).canAdmitAnyway).toBe(false);
  });
});

describe('the three feedback signatures', () => {
  it('collapses every red state onto one tone', () => {
    // §12.2 gives three tones and three vibration patterns for five states.
    // Distinguishing "cancelled" from "invalid" by ear in a loud foyer is not
    // realistic; the screen says it in words. What the sound must carry is
    // "stop and read", and that is one signal.
    const cancelled = evaluateScan({ hash: HASH.cancelled, index: INDEX, checkIns: none });
    const missing = evaluateScan({ hash: HASH.dan.replace('d', '9'), index: INDEX, checkIns: none });
    expect(cancelled.tone).toBe('error');
    expect(missing.tone).toBe('error');
  });
});

describe('every seat is keyed by attendee, ticketed or not (spec/v3.md §32.2)', () => {
  const party = buildManifestIndex([
    entry({ attendeeId: 11, qrTokenSha256: HASH.alice, name: 'Nadia Hassan', registrationId: 9, partySize: 3 }),
    entry({ attendeeId: 12, qrTokenSha256: null, hasTicket: false, ticketCode: null, name: 'Kenji Sato', registrationId: 9, partySize: 3 }),
    entry({ attendeeId: 13, qrTokenSha256: null, hasTicket: false, ticketCode: null, name: 'Haruto Sato', registrationId: 9, partySize: 3 }),
  ]);

  it('keeps two seats with no ticket apart, rather than colliding on a null digest', () => {
    expect(party.byKey.size).toBe(3);
    expect(party.byHash.size).toBe(1);
  });

  it('counts a party member admitted with no ticket against the party, and only them', () => {
    const checkIns: LocalCheckIn[] = [
      { key: 'a12', scannedAt: '2026-09-19T11:00:00.000Z', source: 'MANUAL' },
    ];
    const result = evaluateScan({ hash: HASH.alice, index: party, checkIns });
    expect(result.party).toEqual({ size: 3, admitted: 2, remaining: 1 });
  });

  it('reads as already in when another phone admitted the guest, from the manifest', () => {
    // §12.3's check-in state: the duplicate check is no longer this phone only.
    const synced = buildManifestIndex([
      entry({
        attendeeId: 11,
        qrTokenSha256: HASH.alice,
        checkedInAt: '2026-09-19T11:42:00.000Z',
        checkedInBy: 'Bob',
      }),
    ]);
    const result = evaluateScan({ hash: HASH.alice, index: synced, checkIns: none });
    expect(result.outcome).toBe('ALREADY_CHECKED_IN');
    expect(result.firstScan).toEqual({ at: '2026-09-19T11:42:00.000Z', operatorName: 'Bob' });
  });
});
