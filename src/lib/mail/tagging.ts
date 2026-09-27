import { randomBytes } from 'node:crypto';

/**
 * How an outgoing message is tagged so that what comes back can be matched to
 * whoever it was sent to (spec/v3.md §26.2).
 *
 * Two independent tags, because each one fails somewhere the other survives:
 *
 * - **Our own `Message-ID`.** A reply's `In-Reply-To` and `References`, and a
 *   bounce's quoted original, carry it back. Clients that strip threading
 *   headers lose it.
 * - **A plus-addressed `Reply-To`**, `{local}+p{id}@{domain}`. Gmail delivers
 *   plus-addresses to the same mailbox, and the tag rides in the address the
 *   guest's client replies to, whatever it does with headers.
 *
 * Nothing here knows what a registration or a player is: an addressee is a kind
 * and a number, so this module lifts out of the app as it stands (§26.7).
 */

export type AddresseeKind = 'registration' | 'player';

export type Addressee = { kind: AddresseeKind; id: number };

/**
 * The plus tag's prefix per kind. **`pl` must be tried before `p`** when
 * parsing, or `+pl12` would read as a malformed registration tag.
 */
const PREFIX: Record<AddresseeKind, string> = { registration: 'p', player: 'pl' };

function splitAddress(address: string): { local: string; domain: string } | null {
  const at = address.lastIndexOf('@');
  if (at <= 0 || at === address.length - 1) return null;
  return { local: address.slice(0, at), domain: address.slice(at + 1) };
}

/** The mailbox's own local part, without any plus tag it already carries. */
function baseLocal(local: string): string {
  const plus = local.indexOf('+');
  return plus === -1 ? local : local.slice(0, plus);
}

/**
 * `<{key}.{random}@{domain}>` — the angle brackets are part of the header value.
 *
 * `key` is the outbox row's id, so a `Message-ID` read back from anywhere names
 * the row it came from even before a lookup. The random half is what makes it
 * unique across databases: a restored backup or a second install counting ids
 * from 1 must never mint an id a guest's client has already seen.
 */
export function makeMessageId(key: number | string, senderAddress: string): string {
  const parts = splitAddress(senderAddress);
  if (!parts) throw new Error(`"${senderAddress}" is not an address a Message-ID can be minted for.`);
  return `<${key}.${randomBytes(8).toString('hex')}@${parts.domain.toLowerCase()}>`;
}

/** `events@example.org` → `events+p42@example.org` for registration 42. */
export function plusAddress(mailbox: string, addressee: Addressee): string {
  const parts = splitAddress(mailbox);
  if (!parts) throw new Error(`"${mailbox}" is not an address that can carry a plus tag.`);
  return `${baseLocal(parts.local)}+${PREFIX[addressee.kind]}${addressee.id}@${parts.domain}`;
}

/**
 * The addressee a plus-tagged address names, **only if it is our own mailbox**.
 *
 * Checking the base address is not pedantry: `anyone+p42@elsewhere.example` in
 * a `Cc` must not attach a stranger's mail to party 42. Comparison is
 * case-insensitive, as mail addresses are in practice.
 */
export function parsePlusTag(address: string, mailbox: string): Addressee | null {
  const got = splitAddress(address.trim());
  const ours = splitAddress(mailbox);
  if (!got || !ours) return null;
  if (got.domain.toLowerCase() !== ours.domain.toLowerCase()) return null;

  const plus = got.local.indexOf('+');
  if (plus === -1) return null;
  if (got.local.slice(0, plus).toLowerCase() !== baseLocal(ours.local).toLowerCase()) return null;

  const tag = got.local.slice(plus + 1).toLowerCase();
  const match = /^(pl|p)(\d{1,15})$/.exec(tag);
  if (!match) return null;
  const id = Number(match[2]);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  return { kind: match[1] === 'pl' ? 'player' : 'registration', id };
}

/** The first address in `addresses` that carries our plus tag, if any. */
export function findPlusTag(addresses: readonly string[], mailbox: string): Addressee | null {
  for (const address of addresses) {
    const found = parsePlusTag(address, mailbox);
    if (found) return found;
  }
  return null;
}

/**
 * Normalises a `Message-ID`-shaped value to `<id>` form.
 *
 * Headers arrive with and without brackets, with stray whitespace, and — from
 * some clients — with the brackets inside a comment. Every stored and compared
 * id goes through this, so a match never hinges on which client wrote it.
 */
export function normalizeMessageId(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  const bracketed = /<([^<>\s]+)>/.exec(trimmed);
  const bare = bracketed ? bracketed[1] : trimmed;
  if (!bare || /\s/.test(bare) || !bare.includes('@')) return null;
  // No real id is this long (RFC 5322 caps a header line at 998), and one that
  // is would not fit a unique index: a stranger could stall any store keyed on it.
  if (bare.length > MAX_MESSAGE_ID) return null;
  return `<${bare}>`;
}

/** The longest `Message-ID` accepted, in characters. RFC 5322's line limit. */
export const MAX_MESSAGE_ID = 998;

/** Every `<id>` in a `References`-style header, in order, normalised. */
export function parseMessageIdList(value: string | readonly string[] | null | undefined): string[] {
  if (!value) return [];
  const joined = typeof value === 'string' ? value : value.join(' ');
  const found = joined.match(/<[^<>\s]+>/g) ?? [];
  const ids = found.map((id) => normalizeMessageId(id)).filter((id): id is string => id !== null);
  return [...new Set(ids)];
}
