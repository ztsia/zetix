import { ImapFlow } from 'imapflow';
import type { FolderListing, FolderRole, ListOptions, MailInbox, RawMessage } from './inbox';

export type ImapConfig = {
  host: string;
  port: number;
  /** Implicit TLS. Gmail's IMAP is 993 with `secure: true`. */
  secure: boolean;
  user: string;
  pass: string;
  /**
   * How long to wait for the server to answer at all. A sync runs inside a
   * scheduler tick with a fixed budget; a server that never greets must not
   * spend all of it.
   */
  connectTimeoutMs?: number;
};

/** The special-use flag for each role (RFC 6154). Gmail advertises both. */
const SPECIAL_USE: Record<FolderRole, string> = { inbox: '\\Inbox', sent: '\\Sent' };

/**
 * The IMAP adapter (spec/v3.md §26.3): Gmail in production, authenticated with
 * the same app password as SMTP, since app passwords cover IMAP and no Google
 * OAuth app is needed.
 *
 * **Folders are opened read-only** (`EXAMINE`). The sync is a reader; marking
 * a guest's reply as seen in Gmail would hide it from a person who still reads
 * the mailbox directly, and nothing here should change what they see.
 *
 * Folders are found **by special-use flag**, never by name: Gmail's Sent folder
 * is `[Gmail]/Sent Mail` in English and something else in every other locale
 * the account might be set to.
 */
export async function connectImap(config: ImapConfig): Promise<MailInbox> {
  const client = new ImapFlow({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: { user: config.user, pass: config.pass },
    logger: false,
    // A sync is short-lived and reads on demand; IDLE would only hold the socket open.
    disableAutoIdle: true,
    ...(config.connectTimeoutMs
      ? { connectionTimeout: config.connectTimeoutMs, greetingTimeout: config.connectTimeoutMs }
      : {}),
  });
  // Without a listener an 'error' event is an uncaught exception that takes the process down.
  client.on('error', () => {});
  try {
    await client.connect();
  } catch (error) {
    // A refused login leaves the socket open; without this each failed tick leaks one.
    client.close();
    throw error;
  }

  return {
    async resolve(role) {
      const folders = await client.list();
      const flagged = folders.find((f) => f.specialUse === SPECIAL_USE[role]);
      if (flagged) return flagged.path;
      if (role === 'inbox') return folders.find((f) => f.path.toUpperCase() === 'INBOX')?.path ?? 'INBOX';
      return null;
    },

    async list(path, options: ListOptions): Promise<FolderListing> {
      const lock = await client.getMailboxLock(path, { readOnly: true });
      try {
        const mailbox = client.mailbox;
        if (!mailbox) throw new Error(`Could not open ${path}.`);
        const uidValidity = Number(mailbox.uidValidity);
        let found: number[] = [];
        if ('afterUid' in options) {
          // `n:*` always matches the highest UID, even when it is below n (RFC 3501
          // §6.4.8), so the filter below is what makes "nothing new" read as nothing.
          if (mailbox.exists > 0) {
            found = ((await client.search({ uid: `${options.afterUid + 1}:*` }, { uid: true })) || []) as number[];
          }
          found = found.filter((uid) => uid > options.afterUid);
        } else if (mailbox.exists > 0) {
          found = ((await client.search({ since: options.since }, { uid: true })) || []) as number[];
        }
        return { path, uidValidity, uids: [...new Set(found)].sort((a, b) => a - b) };
      } finally {
        lock.release();
      }
    },

    async fetch(path, uids): Promise<RawMessage[]> {
      if (uids.length === 0) return [];
      const lock = await client.getMailboxLock(path, { readOnly: true });
      try {
        const messages = await client.fetchAll(
          uids.join(','),
          { uid: true, source: true, internalDate: true },
          { uid: true },
        );
        return messages
          .filter((m) => m.source)
          .map((m) => ({
            uid: m.uid,
            raw: m.source as Buffer,
            internalDate: m.internalDate ? new Date(m.internalDate) : null,
          }))
          .sort((a, b) => a.uid - b.uid);
      } finally {
        lock.release();
      }
    },

    async close() {
      try {
        await client.logout();
      } catch {
        client.close();
      }
    },
  };
}
