/**
 * `MailInbox` — reading mail, beside `MailTransport` for sending (spec/v3.md
 * §26.3, §26.7; decision 12's pattern).
 *
 * The interface is shaped around **UID cursors**, because that is what makes a
 * sync resumable: the caller stores `(uidValidity, lastUid)` per folder, asks
 * for what is above it, and advances the cursor one message at a time. A sync
 * cut short by its time budget loses nothing and repeats nothing but the
 * message it was on.
 *
 * Two calls rather than one iterator on purpose: listing UIDs first, then
 * fetching by UID, keeps the adapter free of an open fetch stream while the
 * caller writes to its database between messages — IMAP clients do not
 * tolerate other commands interleaved with a running `FETCH`.
 */

/** Which folder, by role. Adapters resolve roles to the provider's own names. */
export type FolderRole = 'inbox' | 'sent';

export type FolderListing = {
  /** The provider's folder path, e.g. `INBOX` or `[Gmail]/Sent Mail`. */
  path: string;
  /**
   * IMAP's `UIDVALIDITY`. A cursor stored under a different value is void: the
   * server has renumbered the folder, and `lastUid` no longer means anything.
   */
  uidValidity: number;
  /** UIDs to read, ascending. */
  uids: number[];
};

export type ListOptions =
  /** Everything above a stored cursor. */
  | { afterUid: number }
  /** A first sync, or one whose cursor was voided: everything since a date. */
  | { since: Date };

export type RawMessage = {
  uid: number;
  /** The full RFC 822 source. */
  raw: Buffer;
  /** When the server received it, where the adapter can say. */
  internalDate: Date | null;
};

export interface MailInbox {
  /** The folder for a role, or `null` when the mailbox has no such folder. */
  resolve(role: FolderRole): Promise<string | null>;
  list(path: string, options: ListOptions): Promise<FolderListing>;
  /** The messages for these UIDs, ascending. A UID that has since been expunged is simply absent. */
  fetch(path: string, uids: readonly number[]): Promise<RawMessage[]>;
  /** Always call it when the sync is done. */
  close(): Promise<void>;
}
