import { afterAll, describe, expect, it } from 'vitest';
import { buildManifestIndex, entryKey, normaliseEntries, hashQrToken, type ManifestEntry } from '@/lib/checkin/manifest';
import { generateQrToken } from '@/lib/tickets/identifiers';
import { closeDb, sql } from '../helpers/db';

/**
 * The manifest as the phone holds it (spec/checkin.md §12.3).
 *
 * The single property everything else rests on: **the digest the browser
 * computes must equal the digest Postgres put in the manifest.** They are two
 * implementations of one hash, written months apart in two languages, and if
 * they disagree by a byte then every scan at the door is "not found" — with
 * every ticket valid, every guest real, and nothing in the logs to say why.
 * So it is compared against the actual database rather than against a constant
 * someone copied out of it.
 */

afterAll(closeDb);

describe('hashQrToken', () => {
  it('agrees with the manifest function`s own hash, on real tokens', async () => {
    for (let i = 0; i < 25; i++) {
      const token = generateQrToken();
      const [row] = await sql<{ digest: string }[]>`
        select encode(sha256(convert_to(${token}::text, 'UTF8')), 'hex') as digest
      `;
      expect(await hashQrToken(token)).toBe(row.digest);
    }
  });

  it('is lowercase hex of the full 256 bits', async () => {
    const digest = await hashQrToken('aB3dEf7hIj9kLm2nOp5qRs');
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is stable across calls, so a rescan of one ticket looks up the same row', async () => {
    const token = generateQrToken();
    expect(await hashQrToken(token)).toBe(await hashQrToken(token));
  });

  it('separates two tokens that differ only in case', async () => {
    // base62 is case-sensitive; folding here would collide distinct attendees.
    expect(await hashQrToken('aB3dEf7hIj9kLm2nOp5qRs')).not.toBe(
      await hashQrToken('AB3DEF7HIJ9KLM2NOP5QRS'),
    );
  });
});

describe('buildManifestIndex', () => {
  const entries: ManifestEntry[] = normaliseEntries([
    {
      attendeeId: 1,
      qrTokenSha256: 'a'.repeat(64),
      ticketCode: 'ORC-7K4Q',
      name: 'Alice Tan',
      playerName: 'Wei Ling',
      status: 'CONFIRMED',
      registrationId: 7,
      partySize: 2,
    },
    {
      attendeeId: 2,
      qrTokenSha256: 'b'.repeat(64),
      ticketCode: 'ORC-9M2X',
      name: 'Bob Tan',
      playerName: 'Wei Ling',
      status: 'CONFIRMED',
      registrationId: 7,
      partySize: 2,
    },
  ]);

  it('keys every seat by attendee id, never by digest', () => {
    const index = buildManifestIndex([
      ...entries,
      ...normaliseEntries([{ attendeeId: 3, qrTokenSha256: null, name: 'No Ticket', registrationId: 8 }]),
      ...normaliseEntries([{ attendeeId: 4, qrTokenSha256: null, name: 'No Ticket Either', registrationId: 8 }]),
    ]);
    expect([...index.byKey.keys()]).toEqual(['a1', 'a2', 'a3', 'a4']);
    expect(index.byHash.size).toBe(2);
  });

  it('reads a roster saved by an older build, which had no attendee id', () => {
    const [legacy] = normaliseEntries([
      { qrTokenSha256: 'c'.repeat(64), name: 'Old Copy', registrationId: 9, partySize: 1 },
    ]);
    expect(legacy).toMatchObject({ attendeeId: null, hasTicket: true, checkedInAt: null });
    expect(entryKey(legacy)).toBe(`h${'c'.repeat(64)}`);
  });

  it('indexes by digest for the scan path', () => {
    const index = buildManifestIndex(entries);
    expect(index.byHash.get('a'.repeat(64))?.name).toBe('Alice Tan');
    expect(index.byHash.size).toBe(2);
  });

  it('groups a party by registration, which is what Admit remaining reads', () => {
    const index = buildManifestIndex(entries);
    expect(index.byRegistration.get(7)).toHaveLength(2);
  });

  it('handles an empty roster without special-casing', () => {
    const index = buildManifestIndex([]);
    expect(index.entries).toHaveLength(0);
    expect(index.byHash.size).toBe(0);
  });
});
