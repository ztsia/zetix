/**
 * A real IMAP server (hoodiecrow-imap) for module `U`'s browser pass, so the
 * console's "Check now" and the tick read a mailbox over the IMAP protocol with
 * the production adapter. Gmail is unreachable from any container.
 *
 * INBOX: UID 1 is already synced (seed-u sets the cursor); UID 2 is a new reply
 * from Alice by plus tag only; UID 3 is an unmatched stranger (must not be stored).
 * With QA_U_POISON=1, UID 4 is a plus-tagged message carrying a NUL byte.
 */
import hoodiecrow from 'hoodiecrow-imap';

const PORT = Number(process.env.IMAP_PORT ?? 1143);
const USER = process.env.GMAIL_USER ?? 'tickets@example.test';
const ALICE = process.env.QA_ALICE_ID ?? '1';
const now = new Date();
const d = (m) => new Date(now.getTime() - m * 60_000).toUTCString().replace(/^\w+, /, '').replace(/ (\d{4}) /, '-$1 ').replace(/ /, '-').replace(' GMT', ' +0000');

const msg = (lines) => lines.join('\r\n');
const messages = [
  { raw: msg(['From: someone@else.example', `To: ${USER}`, 'Subject: already synced', 'Message-ID: <qa-old@else.example>', '', 'old']), internaldate: d(120) },
  { raw: msg(['From: Alice Tan <alice@example.test>', `To: tickets+p${ALICE}@example.test`, 'Subject: Re: Your tickets', 'Message-ID: <qa-alice-q2@guest.example>',
      'Content-Type: text/plain; charset=utf-8', '', 'IMAP-FOLLOWUP: and is there parking at the hall?']), internaldate: d(5) },
  { raw: msg(['From: spammer@spam.example', `To: ${USER}`, 'Subject: Buy now', 'Message-ID: <qa-spam@spam.example>', '', 'SPAM-UNMATCHED']), internaldate: d(4) },
];
if (process.env.QA_U_POISON === 'long') {
  // A plus-tagged message whose Message-ID is too long for the unique btree index; its body carries contact details.
  const longId = Array.from({ length: 700 }, () => Math.random().toString(36).slice(2, 12)).join('');
  messages.push({ raw: msg(['From: stranger@x.example', `To: tickets+p${ALICE}@example.test`, 'Subject: hello', `Message-ID: <${longId}@x.example>`,
    'Content-Type: text/plain; charset=utf-8', '', 'POISON-BODY call me on +60 19-888 7777 or poison.leak@example.test']), internaldate: d(3) });
  messages.push({ raw: msg(['From: Alice Tan <alice@example.test>', `To: tickets+p${ALICE}@example.test`, 'Subject: Re: Your tickets', 'Message-ID: <qa-alice-q3@guest.example>',
    'Content-Type: text/plain; charset=utf-8', '', 'AFTER-POISON: one more question']), internaldate: d(2) });
}
if (process.env.QA_U_POISON === '1') {
  messages.push({ raw: msg(['From: stranger@x.example', `To: tickets+p${ALICE}@example.test`, 'Subject: poison', 'Message-ID: <qa-poison@x.example>',
    'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: quoted-printable', '', 'x=00y']), internaldate: d(3) });
  messages.push({ raw: msg(['From: Alice Tan <alice@example.test>', `To: tickets+p${ALICE}@example.test`, 'Subject: Re: Your tickets', 'Message-ID: <qa-alice-q3@guest.example>',
    'Content-Type: text/plain; charset=utf-8', '', 'AFTER-POISON: one more question']), internaldate: d(2) });
}

const server = hoodiecrow({
  plugins: ['SPECIAL-USE', 'ID', 'ENABLE', 'UNSELECT'],
  users: { [USER]: { password: 'qa-app-password' } },
  storage: {
    INBOX: { messages },
    '': { separator: '/', folders: { '[Gmail]': { flags: ['\\Noselect'], folders: { 'Sent Mail': { 'special-use': '\\Sent', messages: [] } } } } },
  },
});
server.listen(PORT, '127.0.0.1', () => console.log(`imap on ${PORT}, ${messages.length} messages`));
