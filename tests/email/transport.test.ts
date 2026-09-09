import { afterEach, describe, expect, it } from 'vitest';
import {
  createSmtpTransport,
  createStreamTransport,
  type MailTransport,
  type OutgoingMessage,
} from '@/lib/email/transport';
import { startSmtpSink, type Sink } from '../helpers/smtp-sink';

/**
 * The transport layer, tested against a **real SMTP server** as well as the
 * composer.
 *
 * The property under test is not "can we send mail" — no test here can, since
 * `local.md` §7 measured Gmail's ports as blocked from any container. It is
 * that **the test transports and the production transport cannot diverge**, so
 * swapping the adapter for a local sink and back is a configuration change and
 * nothing else.
 */

const message: OutgoingMessage = {
  to: 'player@example.com',
  toName: 'Wellington Mainwaring',
  // An em dash, because it is the character that separates a real MIME build
  // from a stub: the real path emits RFC 2047, a stub emits the raw string.
  subject: 'Your tickets — Autumn Concert',
  text: 'Your tickets are attached.',
  html: '<p>Your tickets are attached.</p>',
  attachments: [
    { filename: 'autumn-wellington-A1B2C3.pdf', content: new Uint8Array([37, 80, 68, 70]), contentType: 'application/pdf' },
    { filename: 'autumn-guest-D4E5F6.pdf', content: new Uint8Array([37, 80, 68, 70]), contentType: 'application/pdf' },
  ],
};

let sink: Sink | null = null;
let transport: MailTransport | null = null;

afterEach(async () => {
  await transport?.close();
  await sink?.close();
  transport = null;
  sink = null;
});

function smtpTo(port: number) {
  return createSmtpTransport({
    host: '127.0.0.1',
    port,
    secure: false,
    user: 'tickets@example.org',
    pass: 'app-password-here',
    fromName: 'Lakeside Community Orchestra',
  });
}

describe('the composed message', () => {
  it('builds real MIME — multipart, boundaries and an encoded header', async () => {
    transport = createStreamTransport('Lakeside Community Orchestra', 'tickets@example.org');
    const result = await transport.send(message);
    const raw = result.raw?.toString() ?? '';

    expect(raw).toContain('Content-Type: multipart/mixed; boundary=');
    expect(raw).toContain('Content-Type: multipart/alternative;');
    // RFC 2047. `jsonTransport` would leave the em dash raw and this would fail,
    // which is the reason the CI transport is `streamTransport`.
    expect(raw).toContain('Subject: =?UTF-8?Q?');
    expect(raw).not.toContain('Subject: Your tickets — Autumn Concert');
    expect(raw).toContain('Content-Transfer-Encoding: base64');
    expect(raw).toContain('filename=autumn-wellington-A1B2C3.pdf');
    expect(raw).toContain('filename=autumn-guest-D4E5F6.pdf');
  });

  it('addresses the registrant, with the display name quoted', async () => {
    transport = createStreamTransport('Lakeside Community Orchestra', 'tickets@example.org');
    const raw = (await transport.send(message)).raw?.toString() ?? '';

    expect(raw).toContain('To: Wellington Mainwaring <player@example.com>');
    expect(raw).toContain('From: Lakeside Community Orchestra <tickets@example.org>');
  });
});

describe('the stream transport and a real SMTP server agree', () => {
  /**
   * The load-bearing test of the whole design. If these two ever produce
   * different bytes, every assertion made against `streamTransport` in CI stops
   * describing what Gmail would receive, and the sink stops being a stand-in.
   */
  it('puts byte-identical MIME on the wire', async () => {
    sink = await startSmtpSink();
    transport = smtpTo(sink.port);
    await transport.send(message);

    const stream = createStreamTransport('Lakeside Community Orchestra', 'tickets@example.org');
    const streamed = await stream.send(message);
    await stream.close();

    // Message-ID, Date and the boundary are generated per message by design.
    const strip = (b: Buffer) =>
      b
        .toString()
        .replace(/^(Message-ID|Date):.*$/gm, '')
        .replace(/--_NmP-[0-9a-f]+/g, '--BOUNDARY')
        .trim();

    expect(sink.messages).toHaveLength(1);
    expect(strip(sink.messages[0].raw)).toBe(strip(streamed.raw!));
  });
});

describe('the SMTP conversation', () => {
  it('authenticates and sets an envelope Gmail would accept', async () => {
    sink = await startSmtpSink();
    transport = smtpTo(sink.port);
    await transport.send(message);

    expect(sink.auth?.username).toBe('tickets@example.org');
    expect(sink.auth?.password).toBe('app-password-here');
    expect(sink.messages[0].mailFrom).toBe('tickets@example.org');
    expect(sink.messages[0].rcptTo).toEqual(['player@example.com']);
  });

  /**
   * §11.1 costs a send at 1–2s including the SMTP handshake, and
   * `email.max_per_dispatch` is sized against `maxDuration = 60`. Un-pooled
   * nodemailer opens one connection per message, so dropping the pool would
   * spend the budget on TLS handshakes instead of messages.
   */
  it('reuses one connection for the batch', async () => {
    sink = await startSmtpSink();
    transport = smtpTo(sink.port);
    for (let i = 0; i < 5; i += 1) {
      await transport.send({ ...message, to: `guest${i}@example.com` });
    }

    expect(sink.messages).toHaveLength(5);
    expect(sink.connections).toBe(1);
  });
});

describe('the normalized result', () => {
  /**
   * `accepted` / `rejected` / `response` exist **only** on the real SMTP
   * transport. A dispatcher reading nodemailer's `info` directly would throw
   * against Gmail on its first send, or — written defensively — read every
   * rejection as a success and stamp `ticket_sent_at` on mail that was refused.
   */
  it('reports what the server accepted, from a real server', async () => {
    sink = await startSmtpSink();
    transport = smtpTo(sink.port);
    const result = await transport.send(message);

    expect(result.accepted).toEqual(['player@example.com']);
    expect(result.rejected).toEqual([]);
    expect(result.response).toContain('250');
    expect(result.messageId).toBeTruthy();
  });

  /**
   * The mirror-image bug: a transport that reports no acceptance has not
   * rejected anything, and treating its silence as a rejection would make every
   * message composed in CI look like a failed send.
   */
  it('does not read a test transport’s silence as rejection', async () => {
    transport = createStreamTransport('Lakeside Community Orchestra', 'tickets@example.org');
    const result = await transport.send(message);

    expect(result.accepted).toEqual(['player@example.com']);
    expect(result.rejected).toEqual([]);
  });

  it('surfaces a refusal from the far end rather than reporting success', async () => {
    sink = await startSmtpSink({ rejectWith: { code: 550, message: 'No such recipient' } });
    transport = smtpTo(sink.port);

    await expect(transport.send(message)).rejects.toThrow(/No such recipient/);
    expect(sink.messages).toHaveLength(0);
  });
});
