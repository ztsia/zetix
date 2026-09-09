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
  matchedOn: 'ticketCode' | 'name';
};

/**
 * Search the manifest by `ticket_code` or attendee name.
 *
 * Ticket code is tried first and exactly: an operator who types a full code
 * wants that person, not everyone whose name happens to contain those letters.
 * Name matching is a substring on the normalised form, which handles "tan"
 * finding "Alice Tan" and a partial first name finding the rest.
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
  const seen = new Set<string>();

  for (const entry of index.entries) {
    if (entry.ticketCode && normaliseTicketCode(entry.ticketCode) === code) {
      hits.push({ entry, matchedOn: 'ticketCode' });
      seen.add(entry.qrTokenSha256);
    }
  }

  if (name.length > 0) {
    for (const entry of index.entries) {
      if (seen.has(entry.qrTokenSha256)) continue;
      if (normaliseName(entry.name).includes(name)) {
        hits.push({ entry, matchedOn: 'name' });
        seen.add(entry.qrTokenSha256);
      }
    }
  }

  return hits.slice(0, limit);
}
