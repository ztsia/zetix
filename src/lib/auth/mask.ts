import type { Role } from './session';

/**
 * Contact-detail masking for the `VIEWER` role (spec/v3.md §28).
 *
 * A viewer reads every admin screen but sees email addresses and phone numbers
 * masked. **The mask is applied on the server, to the data a page hands its
 * Client Components** — a mask applied in the browser is a mask over data the
 * browser already holds, readable in the RSC payload by anyone who opens the
 * network tab. So the rule for a page is: fetch, then pass the props through
 * {@link maskForRole} before they leave the Server Component.
 *
 * One deep walk rather than a per-column list, because the list is exactly what
 * the next screen forgets: the walk masks
 *
 * - every value under a key naming an email (`email`, `contactEmail`,
 *   `contact_email`, `toEmail`, …), whether or not it is well formed — a
 *   mistyped address is still somebody's address;
 * - every value under a key naming a phone (`phone`, `contactPhone`, `mobile`);
 * - every email-shaped substring of **any other string**, which is what covers
 *   free text: an audit row's `before` / `after`, a form answer, a subject line,
 *   an actor shown by their address.
 *
 * The walk also withholds **access tokens** — a value under a key ending in
 * `token`, and the token in a ticket link (`/t/{token}`) inside text. §28 names
 * only addresses and phones, but a token is not a contact detail so much as the
 * attendee's key: whoever holds a ticket link holds the ticket, and whoever holds
 * a player's invite link can register as them. A read-only role holding either
 * could act as somebody, which is what read-only rules out.
 *
 * Phone numbers inside free text are not pattern-matched: a bare run of digits
 * is as often an id or a count, and masking those would make the screen wrong.
 * A screen that shows a phone outside a phone-named key (a form's phone-type
 * answer) masks it itself with {@link maskPhone}.
 */

const MASK = '•••';

/** Deliberately loose: anything a person would read as an address. */
const EMAIL_IN_TEXT = /[^\s@<>()[\]"',;:]+@[^\s@<>()[\]"',;:]+\.[^\s@<>()[\]"',;:]+/g;
const EMAIL_KEY = /email$/i;
const PHONE_KEY = /phone|mobile/i;
const TOKEN_KEY = /token$/i;
/** The ticket page's path (`src/app/(portal)/t/[token]`), as `ticketUrl()` builds it. */
const TICKET_LINK = /\/t\/[A-Za-z0-9_-]+/g;

/** `zhong@example.com` → `z•••@e•••.com`: enough to tell two rows apart, not to write. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at <= 0) return email.trim() === '' ? email : MASK;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const dot = domain.lastIndexOf('.');
  const tld = dot > 0 ? domain.slice(dot) : '';
  return `${local[0]}${MASK}@${domain[0] ?? ''}${MASK}${tld}`;
}

/** `+65 9123 4567` → `•••67`: the last two digits, so a caller can confirm one. */
export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 0) return phone.trim() === '' ? phone : MASK;
  return `${MASK}${digits.slice(-2)}`;
}

function maskText(text: string): string {
  return text.replace(EMAIL_IN_TEXT, (match) => maskEmail(match)).replace(TICKET_LINK, `/t/${MASK}`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function maskValue(value: unknown, key: string | null): unknown {
  if (typeof value === 'string') {
    if (key && EMAIL_KEY.test(key)) return maskEmail(value);
    if (key && PHONE_KEY.test(key)) return maskPhone(value);
    if (key && TOKEN_KEY.test(key)) return MASK;
    return maskText(value);
  }
  if (Array.isArray(value)) return value.map((item) => maskValue(item, key));
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = maskValue(v, k);
    return out;
  }
  // Dates, Maps, class instances, numbers, booleans, null: nothing to mask, and
  // rebuilding them would change their type.
  return value;
}

/** A deep copy of `value` with every contact detail masked. The input is not changed. */
export function maskContacts<T>(value: T): T {
  return maskValue(value, null) as T;
}

/** Whether this role sees contact details masked. */
export function masksContacts(role: Role): boolean {
  return role === 'VIEWER';
}

/**
 * The call every admin page makes on the props it hands a Client Component.
 * Identity for an admin, {@link maskContacts} for a viewer.
 */
export function maskForRole<T>(role: Role, value: T): T {
  return masksContacts(role) ? maskContacts(value) : value;
}
