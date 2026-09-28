import type { FolderListing, FolderRole, ListOptions, MailInbox, RawMessage } from './inbox';

type StoredMessage = { uid: number; raw: Buffer; internalDate: Date };

type Folder = { path: string; uidValidity: number; nextUid: number; messages: StoredMessage[] };

/**
 * An in-memory `MailInbox`, for tests and for a development machine with no
 * mailbox (§26.7's "test adapters").
 *
 * It keeps IMAP's semantics where the sync depends on them: UIDs only grow,
 * `renumber()` changes `uidValidity` the way a server that rebuilt a folder
 * would, and `since` compares the server's received date, not the message's own.
 */
export class MemoryInbox implements MailInbox {
  private folders = new Map<FolderRole, Folder>();
  closed = 0;

  constructor(paths: Partial<Record<FolderRole, string | null>> = { inbox: 'INBOX', sent: 'Sent' }) {
    for (const role of ['inbox', 'sent'] as const) {
      const path = paths[role];
      if (path) this.folders.set(role, { path, uidValidity: 1, nextUid: 1, messages: [] });
    }
  }

  /** Delivers a message to a folder and returns its UID. */
  deliver(role: FolderRole, raw: string | Buffer, receivedAt: Date = new Date()): number {
    const folder = this.folder(role);
    const uid = folder.nextUid++;
    folder.messages.push({ uid, raw: Buffer.isBuffer(raw) ? raw : Buffer.from(raw), internalDate: receivedAt });
    return uid;
  }

  /** The server rebuilt the folder: new `uidValidity`, every message renumbered. */
  renumber(role: FolderRole): void {
    const folder = this.folder(role);
    folder.uidValidity += 1;
    folder.nextUid = 1;
    for (const message of folder.messages) message.uid = folder.nextUid++;
  }

  private folder(role: FolderRole): Folder {
    const folder = this.folders.get(role);
    if (!folder) throw new Error(`This inbox has no ${role} folder.`);
    return folder;
  }

  private byPath(path: string): Folder {
    for (const folder of this.folders.values()) if (folder.path === path) return folder;
    throw new Error(`No folder ${path}.`);
  }

  async resolve(role: FolderRole): Promise<string | null> {
    return this.folders.get(role)?.path ?? null;
  }

  async list(path: string, options: ListOptions): Promise<FolderListing> {
    const folder = this.byPath(path);
    const uids = folder.messages
      .filter((m) => ('afterUid' in options ? m.uid > options.afterUid : m.internalDate >= options.since))
      .map((m) => m.uid)
      .sort((a, b) => a - b);
    return { path, uidValidity: folder.uidValidity, uids, highestUid: folder.nextUid - 1 };
  }

  async fetch(path: string, uids: readonly number[]): Promise<RawMessage[]> {
    const wanted = new Set(uids);
    return this.byPath(path)
      .messages.filter((m) => wanted.has(m.uid))
      .sort((a, b) => a.uid - b.uid)
      .map((m) => ({ uid: m.uid, raw: m.raw, internalDate: m.internalDate }));
  }

  async close(): Promise<void> {
    this.closed += 1;
  }
}
