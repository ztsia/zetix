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
