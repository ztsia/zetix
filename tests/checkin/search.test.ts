import { describe, expect, it } from 'vitest';
import { buildManifestIndex, type ManifestEntry } from '@/lib/checkin/manifest';
import { normaliseTicketCode, searchManifest, searchParties } from '@/lib/checkin/search';
import { parseTicketCode } from '@/lib/tickets/identifiers';

/**
 * Search is the door's fallback when a QR will not read (spec/ref.md §1.2), and
 * it runs against the same offline manifest as the camera — so everything here
 * holds with no network.
 */

function entry(over: Partial<ManifestEntry> & Pick<ManifestEntry, 'qrTokenSha256'>): ManifestEntry {
  return {
    attendeeId: null,
    hasTicket: true,
    ticketCode: 'ORC-7K4Q',
    name: 'Alice Tan',
    nameSource: 'PROVIDED',
    playerName: null,
    status: 'CONFIRMED',
    registrationId: 1,
    partySize: 1,
    segmentName: null,
    checkedInAt: null,
    checkedInBy: null,
    ...over,
  };
}

const INDEX = buildManifestIndex([
  entry({ qrTokenSha256: '1'.repeat(64), name: 'Alice Tan', ticketCode: 'ORC-7K4Q' }),
  entry({ qrTokenSha256: '2'.repeat(64), name: 'Zoë Fernandez', ticketCode: 'ORC-9M2X' }),
  entry({
    qrTokenSha256: '3'.repeat(64),
    name: 'Marcus Lee',
    ticketCode: 'ORC-4T8B',
    status: 'CANCELLED',
  }),
  entry({ qrTokenSha256: '4'.repeat(64), name: 'Guest of Alice Tan', ticketCode: 'ORC-5H1D' }),
]);

describe('by ticket code', () => {
  it('finds an exact code', () => {
    const hits = searchManifest(INDEX, 'ORC-7K4Q');
    expect(hits).toHaveLength(1);
    expect(hits[0].entry.name).toBe('Alice Tan');
    expect(hits[0].matchedOn).toBe('ticketCode');
  });

  it('forgives what a person actually types', () => {
    for (const typed of ['orc-7k4q', 'ORC7K4Q', ' orc 7k4q ', 'ORC-7K4Q ']) {
      expect(searchManifest(INDEX, typed)[0]?.entry.name).toBe('Alice Tan');
    }
  });

  it('recovers the confusable characters the Crockford alphabet exists for', () => {
    // Someone reading `ORC-4T8B` off paper types O for 0 and I for 1 all night.
    expect(normaliseTicketCode('ORC-4T8B')).toBe(normaliseTicketCode('0RC-4T8B'));
    expect(normaliseTicketCode('ORC-1T8B')).toBe(normaliseTicketCode('ORC-IT8B'));
    expect(normaliseTicketCode('ORC-1T8B')).toBe(normaliseTicketCode('ORC-LT8B'));
    expect(normaliseTicketCode('ORC-VT8B')).toBe(normaliseTicketCode('ORC-UT8B'));
  });

  it('agrees with module D`s parser, which is the authority on the format', () => {
    // The two tables are copies — D's cannot be imported into a browser bundle
    // (`node:crypto` at module scope). A drift between them is an usher typing
    // a code the door then cannot find, so it is asserted rather than trusted.
    const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
    for (const a of alphabet) {
      for (const b of alphabet) {
        const code = `ORC-${a}${b}${a}${b}`;
        const parsed = parseTicketCode(code);
        expect(parsed).not.toBeNull();
        expect(normaliseTicketCode(code)).toBe(normaliseTicketCode(parsed!.normalised));
      }
    }
    for (const [typed, canonical] of [
      ['ORC-O123', 'ORC-0123'],
      ['ORC-I234', 'ORC-1234'],
      ['ORC-L345', 'ORC-1345'],
      ['ORC-U456', 'ORC-V456'],
    ]) {
      expect(normaliseTicketCode(typed)).toBe(normaliseTicketCode(parseTicketCode(canonical)!.normalised));
    }
  });
});

describe('by partial ticket code', () => {
  /*
   * The whole reason this exists: `ORC` is a constant prefix, so what an usher
   * reads off a printed ticket and types is the four-symbol body.
   */
  it('finds a ticket from the body alone, without the prefix', () => {
    const hits = searchManifest(INDEX, '7K4Q');
    expect(hits).toHaveLength(1);
    expect(hits[0].entry.name).toBe('Alice Tan');
    expect(hits[0].matchedOn).toBe('ticketCodePartial');
  });

  it('finds one from a prefix of the body, part-way through typing', () => {
    expect(searchManifest(INDEX, '9M2').map((h) => h.entry.name)).toEqual(['Zoë Fernandez']);
  });

  it('still forgives confusables in a partial', () => {
    // O -> 0, so a typed `4T8B` and `4t8b` land on the same normalised body.
    expect(searchManifest(INDEX, '4t8b').map((h) => h.entry.name)).toEqual(['Marcus Lee']);
  });

  it('ignores fragments shorter than the minimum', () => {
    // `4` appears in ORC-7K4Q and ORC-4T8B; two characters of noise at a door
    // is worse than nothing.
    expect(searchManifest(INDEX, '4')).toHaveLength(0);
  });

  it('an exact match still comes first', () => {
    const index = buildManifestIndex([
      entry({ qrTokenSha256: 'a'.repeat(64), name: 'Exact', ticketCode: 'ORC-8B4T' }),
      entry({ qrTokenSha256: 'b'.repeat(64), name: 'Contains', ticketCode: 'ORC-8B4T9' }),
    ]);
    const hits = searchManifest(index, 'ORC-8B4T');
    expect(hits[0].entry.name).toBe('Exact');
    expect(hits[0].matchedOn).toBe('ticketCode');
  });

  it('a name match outranks a code that merely contains the same letters', () => {
    // Typing a surname must not be buried by whoever happens to hold a code
    // with those characters inside it.
    const index = buildManifestIndex([
      entry({ qrTokenSha256: 'c'.repeat(64), name: 'Someone Else', ticketCode: 'ORC-B4TZ' }),
      entry({ qrTokenSha256: 'd'.repeat(64), name: 'B4T Person', ticketCode: 'ORC-9999' }),
    ]);
    const hits = searchManifest(index, 'b4t');
    expect(hits[0].entry.name).toBe('B4T Person');
    expect(hits[0].matchedOn).toBe('name');
    expect(hits[1].matchedOn).toBe('ticketCodePartial');
  });

  it('never returns the same attendee twice', () => {
    const index = buildManifestIndex([
      entry({ qrTokenSha256: 'e'.repeat(64), name: '7K4Q', ticketCode: 'ORC-7K4Q' }),
    ]);
    expect(searchManifest(index, '7K4Q')).toHaveLength(1);
  });
});

describe('by name', () => {
  it('finds a partial name', () => {
    expect(searchManifest(INDEX, 'alice').map((h) => h.entry.name)).toEqual([
      'Alice Tan',
      'Guest of Alice Tan',
    ]);
  });

  it('folds diacritics both ways', () => {
    expect(searchManifest(INDEX, 'zoe')[0]?.entry.name).toBe('Zoë Fernandez');
    expect(searchManifest(INDEX, 'Zoë')[0]?.entry.name).toBe('Zoë Fernandez');
  });

  it('finds a placeholder attendee, who has no name of their own', () => {
    // decision 32: an imported seat with no name tickets as "Guest of {contact}".
    // They arrive at the door like anyone else.
    expect(searchManifest(INDEX, 'guest of')[0]?.entry.name).toBe('Guest of Alice Tan');
  });
});

describe('what search must not hide', () => {
  it('returns cancelled attendees', () => {
    // The reason they are in the manifest at all: the door says "cancelled —
    // refer to desk", never "not found" (spec/allocation.md §7.9). Filtering
    // them out of search reinstates the lie exactly where someone whose QR
    // will not scan gets looked up by name.
    const hits = searchManifest(INDEX, 'Marcus');
    expect(hits).toHaveLength(1);
    expect(hits[0].entry.status).toBe('CANCELLED');
  });

  it('returns nothing for an empty query rather than the whole roster', () => {
    expect(searchManifest(INDEX, '')).toEqual([]);
    expect(searchManifest(INDEX, '   ')).toEqual([]);
  });
});

describe('search finds a party, not a row (spec/v3.md §32.2)', () => {
  const party = (
    registrationId: number,
    rows: Partial<ManifestEntry>[],
  ): ManifestEntry[] =>
    rows.map((r, i) =>
      entry({
        attendeeId: registrationId * 10 + i,
        qrTokenSha256: r.hasTicket === false ? null : `${registrationId}${i}`.padEnd(64, 'a'),
        registrationId,
        partySize: rows.filter((x) => x.status !== 'CANCELLED').length,
        ticketCode: r.hasTicket === false ? null : `ORC-${registrationId}${i}AA`,
        ...r,
      }),
    );

  const roster = buildManifestIndex([
    ...party(1, [
      { name: 'Nadia Hassan' },
      { name: 'Guest of Nadia Hassan', nameSource: 'PLACEHOLDER' },
    ]),
    ...party(2, [
      { name: 'Kenji Sato', hasTicket: false },
      { name: 'Yui Sato', hasTicket: false },
    ]),
    ...party(3, [{ name: 'Haruto Sato' }]),
    ...party(4, [{ name: 'Marcus Lee', status: 'CANCELLED' }]),
    ...party(5, [{ name: 'Satoko Ishii' }]),
  ]);
  const none = new Set<string>();

  it('returns one result for a party, whichever member matched', () => {
    const result = searchParties(roster, 'nadia', { admittedKeys: none, notInOnly: true });
    expect(result.parties).toHaveLength(1);
    expect(result.parties[0]).toMatchObject({ registrationId: 1, size: 2, admitted: 0, label: 'Nadia Hassan' });
  });

  it('finds every seat with no ticket, which the old row search dropped', () => {
    const result = searchParties(roster, 'sato', { admittedKeys: none, notInOnly: true });
    expect(result.parties.map((p) => p.registrationId).sort()).toEqual([2, 3, 5]);
    expect(result.parties.find((p) => p.registrationId === 2)?.state).toBe('NO_TICKET');
  });

  it('ranks a match at the start of a word before one inside it', () => {
    const result = searchParties(roster, 'sato', { admittedKeys: none, notInOnly: true });
    // "Satoko" starts with it; the Satos have it as a surname; all are word starts.
    expect(result.parties.every((p) => p.highlight !== null)).toBe(true);
    const ishii = searchParties(roster, 'atok', { admittedKeys: none, notInOnly: true });
    expect(ishii.parties[0].label).toBe('Satoko Ishii');
    expect(ishii.parties[0].highlight).toEqual({ start: 1, end: 5 });
  });

  it('hides a party that is all in under "Not in", and shows it under "All"', () => {
    const inKeys = new Set([roster.keyOf(roster.entries[0]), roster.keyOf(roster.entries[1])]);
    expect(searchParties(roster, 'nadia', { admittedKeys: inKeys, notInOnly: true }).parties).toEqual([]);
    const all = searchParties(roster, 'nadia', { admittedKeys: inKeys, notInOnly: false });
    expect(all.parties[0]).toMatchObject({ state: 'ALL_IN', admitted: 2 });
  });

  it('says "2 of 4 in" by counting only live seats', () => {
    const half = new Set([roster.keyOf(roster.entries[0])]);
    const result = searchParties(roster, 'nadia', { admittedKeys: half, notInOnly: true });
    expect(result.parties[0]).toMatchObject({ state: 'PARTLY_IN', admitted: 1, size: 2 });
  });

  it('still finds a cancelled guest under "Not in", so the door can say why', () => {
    const result = searchParties(roster, 'marcus', { admittedKeys: none, notInOnly: true });
    expect(result.parties[0].state).toBe('CANCELLED');
  });

  it('never calls a party by a placeholder when a member has a real name', () => {
    const result = searchParties(roster, 'guest of', { admittedKeys: none, notInOnly: true });
    expect(result.parties[0].label).toBe('Nadia Hassan');
  });

  it('counts what was cut, so the screen can say "keep typing"', () => {
    const result = searchParties(roster, 'sa', { admittedKeys: none, notInOnly: false, limit: 2 });
    expect(result.parties).toHaveLength(2);
    expect(result.total).toBeGreaterThan(2);
  });

  it('asks for a second letter rather than matching a third of the roster', () => {
    const result = searchParties(roster, 's', { admittedKeys: none, notInOnly: false });
    expect(result.parties).toEqual([]);
    expect(result.tooShort).toBe(true);
  });

  it('finds a party by its full ticket code', () => {
    const result = searchParties(roster, 'ORC-30AA', { admittedKeys: none, notInOnly: true });
    expect(result.parties[0].registrationId).toBe(3);
    expect(result.parties[0].matchedOn).toBe('ticketCode');
  });
});
