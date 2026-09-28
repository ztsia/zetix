import type { AddressInfo } from 'node:net';
import hoodiecrow from 'hoodiecrow-imap';
import { afterEach, describe, expect, it } from 'vitest';
import { connectImap } from '@/lib/mail/imap';
import type { MailInbox } from '@/lib/mail/inbox';

/**
 * The IMAP adapter over a real IMAP conversation (spec/v3.md §26.3).
 *
 * `hoodiecrow-imap` is a protocol-level test server by the author of
 * `imapflow`: the adapter speaks the same IMAP to it as to Gmail, so this
 * proves the commands, the special-use lookup and the UID arithmetic. What it
 * cannot prove is Gmail's own behaviour and authentication — that is a manual
 * check (`local.md` §16).
 */

let server: ReturnType<typeof hoodiecrow> | null = null;
let inbox: MailInbox | null = null;

afterEach(async () => {
  await inbox?.close();
  inbox = null;
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
});

const message = (id: string) => `From: guest@guest.example\r\nSubject: ${id}\r\nMessage-ID: <${id}@guest.example>\r\n\r\nbody ${id}`;

async function start(inboxMessages: { raw: string; internaldate: string }[]) {
  server = hoodiecrow({
    plugins: ['SPECIAL-USE', 'ID', 'ENABLE', 'UNSELECT'],
    storage: {
      INBOX: { messages: inboxMessages },
      '': {
        separator: '/',
        folders: {
          '[Gmail]': {
            flags: ['\\Noselect'],
            folders: {
              // Localised on purpose: the adapter must find it by flag, not by name.
              'Gesendet': { 'special-use': '\\Sent', messages: [{ raw: message('sent-1'), internaldate: '20-Sep-2026 10:00:00 +0000' }] },
            },
          },
        },
      },
    },
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const { port } = server.server.address() as AddressInfo;
  inbox = await connectImap({ host: '127.0.0.1', port, secure: false, user: 'testuser', pass: 'testpass', connectTimeoutMs: 5000 });
  return inbox;
}

describe('the IMAP adapter', () => {
  it('finds the inbox and the sent folder by special-use flag', async () => {
    const i = await start([]);
    expect(await i.resolve('inbox')).toBe('INBOX');
    expect(await i.resolve('sent')).toBe('[Gmail]/Gesendet');
  });

  it('lists UIDs above a cursor, and nothing when there is nothing new', async () => {
    const i = await start([
      { raw: message('a'), internaldate: '20-Sep-2026 10:00:00 +0000' },
      { raw: message('b'), internaldate: '21-Sep-2026 10:00:00 +0000' },
      { raw: message('c'), internaldate: '22-Sep-2026 10:00:00 +0000' },
    ]);
    const all = await i.list('INBOX', { afterUid: 0 });
    expect(all.uids).toEqual([1, 2, 3]);
    expect(all.uidValidity).toBeGreaterThan(0);
    expect(all.highestUid).toBe(3);
    expect((await i.list('INBOX', { afterUid: 1 })).uids).toEqual([2, 3]);
    // `4:*` matches the highest UID on a real server; the adapter must not return it.
    expect((await i.list('INBOX', { afterUid: 3 })).uids).toEqual([]);
  });

  it('lists by received date for a first sync', async () => {
    const i = await start([
      { raw: message('old'), internaldate: '01-Aug-2026 10:00:00 +0000' },
      { raw: message('new'), internaldate: '22-Sep-2026 10:00:00 +0000' },
    ]);
    expect((await i.list('INBOX', { since: new Date('2026-09-01T00:00:00Z') })).uids).toEqual([2]);
  });

  it('fetches full sources by UID, ascending', async () => {
    const i = await start([
      { raw: message('a'), internaldate: '20-Sep-2026 10:00:00 +0000' },
      { raw: message('b'), internaldate: '21-Sep-2026 10:00:00 +0000' },
    ]);
    const fetched = await i.fetch('INBOX', [2, 1]);
    expect(fetched.map((m) => m.uid)).toEqual([1, 2]);
    expect(fetched[1].raw.toString()).toContain('Message-ID: <b@guest.example>');
    expect(await i.fetch('INBOX', [])).toEqual([]);
  });

  it('refuses a wrong password rather than reading nothing', async () => {
    await start([]);
    const { port } = server!.server.address() as AddressInfo;
    await expect(
      connectImap({ host: '127.0.0.1', port, secure: false, user: 'testuser', pass: 'wrong', connectTimeoutMs: 5000 }),
    ).rejects.toThrow();
  });
});
