import type { ManifestEntry, ManifestIndex } from './manifest';

/**
 * The Search tab — the door's second and third ways in (spec/ref.md §1.2,
 * spec/tickets.md §10.1 rule 4).
 *
 * **This tab is not optional.** At a real door several people per hundred
 * cannot present a scannable code — a cracked screen, a ticket printed too
 * small, a dead phone battery — and without it the queue stops. It searches the
 * same offline manifest the camera does, so `ticket_code` lookup and name
 * lookup both work with no camera and no network. Two of the three ways in
 * therefore survive losing both.
 */

/**
 * Crockford's input mappings, for a code typed off paper at a door.
 *
 * **This deliberately mirrors `parseTicketCode()` in
 * `src/lib/tickets/identifiers.ts`, and `tests/checkin/search.test.ts` compares
 * the two across the whole code space rather than trusting this comment.**
 * D's parser cannot be imported here: it pulls in `node:crypto` at module
 * scope for minting, and this file runs in the browser. Copying the table was
 * the lesser of the two evils against widening D's module, but a silent drift
 * between them is an usher typing a code that the door then cannot find — so
 * the agreement is asserted, not asserted-in-prose.
 */
const CONFUSABLES: Record<string, string> = { O: '0', I: '1', L: '1', U: 'V' };

/**
 * A typed ticket code, reduced to something comparable against the column.
 *
 * Lenient on everything a person under time pressure gets wrong: case, the
 * hyphen, stray spaces, and the four confusable pairs the Crockford alphabet
 * exists to recover.
 */
export function normaliseTicketCode(input: string): string {
  return input
    .toUpperCase()
    .replace(/[\s-]+/g, '')
    .split('')
    .map((c) => CONFUSABLES[c] ?? c)
    .join('');
}

/**
 * A name, reduced for comparison.
 *
 * Diacritics are folded because the roster is imported from a spreadsheet
 * someone else typed and the usher is reading a name off a phone screen —
 * "Zoë" must find "Zoe" and the reverse. `NFD` then stripping combining marks
 * is the whole of it, and it is safe on the Latin script this roster uses.
 */
export function normaliseName(input: string): string {
  return input
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export type SearchHit = {
  entry: ManifestEntry;
  /** Why it matched, so the UI can show the code when that is what was typed. */
  matchedOn: 'ticketCode' | 'ticketCodePartial' | 'name';
};

/**
 * Shortest query that may match part of a code rather than all of it.
 *
 * A `ticket_code` body is four Crockford symbols (`identifiers.ts`), so three
 * is "nearly all of it" while still being enough to be deliberate. Below that
 * a single letter typed towards a name would match a third of the roster on
 * codes alone, and the usher would be reading past noise while a queue builds.
 *
 * Not an operational value (`CLAUDE.md`): it is a property of the code format,
 * not of this concert, and it does not belong in the settings cascade.
 */
const MIN_PARTIAL_CODE_LENGTH = 3;

/**
 * Search the manifest by `ticket_code` or attendee name.
 *
 * Ticket code is tried first and exactly: an operator who types a full code
 * wants that person, not everyone whose name happens to contain those letters.
 * Name matching is a substring on the normalised form, which handles "tan"
 * finding "Alice Tan" and a partial first name finding the rest.
 *
 * **A partial code matches too**, from `MIN_PARTIAL_CODE_LENGTH` characters up.
 * Codes read `ORC-7KTD`, where `ORC` is a constant prefix, so the part an usher
 * reads off a printed ticket and types is the four-symbol body — and requiring
 * the whole string meant `7KTD` found nothing while `ORC-7KTD` found the ticket.
 * That reads as "code search does not work", because the difference between a
 * lookup that needs the prefix and one that does not is invisible from the
 * door.
 *
 * Cancelled attendees are **included**, and deliberately — the whole reason
 * they are in the manifest is so the door can say "cancelled — refer to desk"
 * instead of "not found" (spec/allocation.md §7.9). Hiding them from search
 * would put that promise back exactly where the guest is most likely to be
 * looked up by name.
 */
export function searchManifest(
  index: ManifestIndex,
  query: string,
  limit = 25,
): SearchHit[] {
  const raw = query.trim();
  if (raw.length === 0) return [];

  const code = normaliseTicketCode(raw);
  const name = normaliseName(raw);
  const hits: SearchHit[] = [];
  const partial: SearchHit[] = [];
  const seen = new Set<string>();

  for (const entry of index.entries) {
    if (!entry.ticketCode) continue;
    const entryCode = normaliseTicketCode(entry.ticketCode);
    if (entryCode === code) {
      hits.push({ entry, matchedOn: 'ticketCode' });
      seen.add(index.keyOf(entry));
    } else if (code.length >= MIN_PARTIAL_CODE_LENGTH && entryCode.includes(code)) {
      // Held back rather than pushed, so a name query that happens to look like
      // part of a code cannot bury the person the usher was actually typing.
      partial.push({ entry, matchedOn: 'ticketCodePartial' });
    }
  }

  if (name.length > 0) {
    for (const entry of index.entries) {
      if (seen.has(index.keyOf(entry))) continue;
      if (normaliseName(entry.name).includes(name)) {
        hits.push({ entry, matchedOn: 'name' });
        seen.add(index.keyOf(entry));
      }
    }
  }

  /*
   * Exact code, then names, then partial codes.
   *
   * A code fragment matches no name, so when a fragment is what was typed the
   * partial hits are the only hits and lead anyway. The ordering only bites the
   * other way round — typing a surname that also appears inside somebody's code
   * — and there the name is what was meant.
   */
  for (const hit of partial) {
    if (!seen.has(index.keyOf(hit.entry))) {
      hits.push(hit);
      seen.add(index.keyOf(hit.entry));
    }
  }

  return hits.slice(0, limit);
}

// ---------------------------------------------------------------------------
// Parties (spec/v3.md §32.2)
// ---------------------------------------------------------------------------

/**
 * Shortest name query that searches at all. One letter matches a third of any
 * roster; the list it produced was a wall the usher had to read past while a
 * queue built. A property of names, not an operational value.
 */
export const MIN_NAME_QUERY_LENGTH = 2;

/** How a party stands at the door, carried by shape as well as colour. */
export type PartyState = 'NOT_IN' | 'PARTLY_IN' | 'ALL_IN' | 'CANCELLED' | 'NO_TICKET';

export type PartyHit = {
  registrationId: number;
  /** Every member of the party on this phone's roster, cancelled ones too. */
  members: readonly ManifestEntry[];
  /** The member whose name or code matched. */
  matched: ManifestEntry;
  matchedOn: SearchHit['matchedOn'];
  /** Where the query sits in `matched.name`, for the highlight; null when it cannot be placed. */
  highlight: { start: number; end: number } | null;
  /** A name to call the party by: never a placeholder when anyone has a real one. */
  label: string;
  /** Live seats (cancelled excluded), and how many of them are in. */
  size: number;
  admitted: number;
  state: PartyState;
};

export type PartySearch = {
  parties: PartyHit[];
  /** Parties that matched before the list was cut short. */
  total: number;
  /** The query is too short to search on names yet. */
  tooShort: boolean;
};

/**
 * Search the roster and answer with **parties, not rows** (spec/v3.md §32.2).
 *
 * A party of four used to come back as four unrelated rows, and the usher had
 * to open each to learn they were one booking. Now each party is one result,
 * whichever member matched, with how many of it are already in.
 *
 * `notInOnly` is the "Not in" filter, on by default: a party whose every seat
 * is in is hidden. A cancelled or unticketed member counts as not in, so the
 * door can still find them and say why.
 *
 * Ranking: exact code, then a name match at the start of a word, then
 * anywhere in a name, then a partial code; a party with somebody still
 * outside before one that is all in.
 */
export function searchParties(
  index: ManifestIndex,
  query: string,
  options: { admittedKeys: ReadonlySet<string>; notInOnly: boolean; limit?: number },
): PartySearch {
  const raw = query.trim();
  const limit = options.limit ?? 25;
  if (raw.length === 0) return { parties: [], total: 0, tooShort: false };

  const code = normaliseTicketCode(raw);
  const name = normaliseName(raw);
  const nameSearch = name.length >= MIN_NAME_QUERY_LENGTH;
  const codeSearch = code.length >= MIN_PARTIAL_CODE_LENGTH;

  // rank: 0 exact code, 1 word-start name, 2 name substring, 3 partial code
  const best = new Map<number, { entry: ManifestEntry; rank: number; matchedOn: SearchHit['matchedOn'] }>();
  const consider = (entry: ManifestEntry, rank: number, matchedOn: SearchHit['matchedOn']) => {
    const current = best.get(entry.registrationId);
    if (!current || rank < current.rank) best.set(entry.registrationId, { entry, rank, matchedOn });
  };

  for (const entry of index.entries) {
    if (entry.ticketCode) {
      const entryCode = normaliseTicketCode(entry.ticketCode);
      if (entryCode === code) consider(entry, 0, 'ticketCode');
      else if (codeSearch && entryCode.includes(code)) consider(entry, 3, 'ticketCodePartial');
    }
    if (nameSearch) {
      const entryName = normaliseName(entry.name);
      const at = entryName.indexOf(name);
      if (at === 0 || (at > 0 && entryName[at - 1] === ' ')) consider(entry, 1, 'name');
      else if (at > 0) consider(entry, 2, 'name');
    }
  }

  const hits: (PartyHit & { rank: number })[] = [];
  for (const { entry, rank, matchedOn } of best.values()) {
    const members = index.byRegistration.get(entry.registrationId) ?? [entry];
    const hit = partyHit(index, members, entry, matchedOn, raw, options.admittedKeys);
    if (options.notInOnly && hit.state === 'ALL_IN') continue;
    hits.push({ ...hit, rank });
  }

  const outside = (h: PartyHit) => (h.state === 'ALL_IN' ? 1 : 0);
  hits.sort(
    (a, b) =>
      a.rank - b.rank || outside(a) - outside(b) || a.label.localeCompare(b.label),
  );

  return {
    parties: hits.slice(0, limit).map(withoutRank),
    total: hits.length,
    tooShort: !nameSearch && !codeSearch && hits.length === 0,
  };
}

function withoutRank(hit: PartyHit & { rank: number }): PartyHit {
  const { rank, ...rest } = hit;
  void rank;
  return rest;
}

function partyHit(
  index: ManifestIndex,
  members: readonly ManifestEntry[],
  matched: ManifestEntry,
  matchedOn: SearchHit['matchedOn'],
  query: string,
  admittedKeys: ReadonlySet<string>,
): PartyHit {
  const live = members.filter((m) => m.status !== 'CANCELLED');
  const admitted = live.filter((m) => admittedKeys.has(index.keyOf(m))).length;
  const named = members.find((m) => m.nameSource !== 'PLACEHOLDER');

  let state: PartyState;
  if (live.length === 0) state = 'CANCELLED';
  else if (admitted === live.length) state = 'ALL_IN';
  else if (admitted > 0) state = 'PARTLY_IN';
  else if (live.every((m) => !m.hasTicket)) state = 'NO_TICKET';
  else state = 'NOT_IN';

  return {
    registrationId: matched.registrationId,
    members,
    matched,
    matchedOn,
    highlight: matchedOn === 'name' ? highlightIn(matched.name, query) : null,
    label: named?.name ?? matched.name,
    size: live.length,
    admitted,
    state,
  };
}

/**
 * Where a query sits in a name, in the name's own characters. Placed only when
 * folding left the length alone — a decomposed accent would shift it — because
 * a highlight one letter off is worse than none.
 */
function highlightIn(original: string, query: string): { start: number; end: number } | null {
  const folded = original
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  if (folded.length !== original.length) return null;
  const needle = normaliseName(query);
  const at = folded.indexOf(needle);
  return at < 0 ? null : { start: at, end: at + needle.length };
}
