import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseMessage } from '@/lib/mail/parse';

/**
 * Reading what a message says about itself (spec/v3.md §26.3–§26.4). The
 * fixtures are shaped on real notices: Gmail's own DSN, a delay notice that
 * must not read as a bounce, and a non-standard postmaster message.
 */

const fixture = (name: string) => readFileSync(join(__dirname, 'fixtures', name));

describe('a reply', () => {
  it('reads threading headers, sender and every recipient', async () => {
    const m = await parseMessage(fixture('reply.eml'));
    expect(m.messageId).toBe('<CAF=reply-1@mail.guest.example>');
    expect(m.inReplyTo).toBe('<41.9f2c1e0a7b3d4c5e@example.org>');
    expect(m.references).toEqual(['<40.0000000000000000@example.org>', '<41.9f2c1e0a7b3d4c5e@example.org>']);
    expect(m.from).toEqual({ address: 'guest@guest.example', name: 'Ada Guest' });
    expect(m.recipients).toEqual(expect.arrayContaining(['events+p41@example.org', 'events@example.org']));
    expect(m.subject).toBe('Re: Your tickets');
    expect(m.text).toContain('Can I bring my daughter');
    expect(m.date?.toISOString()).toBe('2026-09-26T04:00:00.000Z');
    expect(m.bounce).toBeNull();
  });

  it('stores HTML sanitised: no script, no image, no handler, no javascript: link', async () => {
    const { html } = await parseMessage(fixture('reply.eml'));
    expect(html).toContain('<b>daughter</b>');
    expect(html).not.toMatch(/<script|alert\(1\)|<img|tracker\.example|onclick|javascript:/i);
    // Links survive, and open away from the console.
    expect(html).toContain('href="https://guest.example"');
    expect(html).toContain('rel="noopener noreferrer nofollow"');
  });

  it('gives an HTML-only reply a text body too, so a reader never sees an empty message', async () => {
    const m = await parseMessage(fixture('html-only.eml'));
    expect(m.html).toContain('<i>see you</i>');
    expect(m.text).toContain('see you');
  });
});

describe('delivery-status notifications', () => {
  it("reads Gmail's DSN: failed, the code, the diagnostic, and the original's Message-ID", async () => {
    const m = await parseMessage(fixture('gmail-bounce.eml'));
    expect(m.bounce).toEqual({
      action: 'failed',
      originalMessageId: '<41.9f2c1e0a7b3d4c5e@example.org>',
      recipient: 'nobody@invalid-guest.example',
      status: '5.1.1',
      diagnostic: expect.stringContaining('550-5.1.1 The email account that you tried to reach does not exist.'),
    });
    // Folded continuation lines are joined, not cut at the first line.
    expect(m.bounce?.diagnostic).toContain('unnecessary spaces');
  });

  it('reads a delay notice as delayed — never as a bounce', async () => {
    const m = await parseMessage(fixture('delayed.eml'));
    expect(m.bounce?.action).toBe('delayed');
    expect(m.bounce?.originalMessageId).toBe('<55.aaaaaaaaaaaaaaaa@example.org>');
    expect(m.bounce?.status).toBe('4.4.1');
  });

  it('reads a postmaster notice with no report part from its permanent code and pasted headers', async () => {
    const m = await parseMessage(fixture('postmaster-plain.eml'));
    expect(m.bounce?.action).toBe('failed');
    expect(m.bounce?.originalMessageId).toBe('<60.bbbbbbbbbbbbbbbb@example.org>');
    expect(m.bounce?.status).toBe('5.1.1');
  });

  it('does not read a guest who writes "Status: 5.1.1" in a reply as a bounce', async () => {
    const raw = [
      'From: guest@guest.example',
      'To: events+p5@example.org',
      'Subject: Re: hello',
      'Message-ID: <x-1@guest.example>',
      'Content-Type: text/plain',
      '',
      'Action: failed',
      'Status: 5.1.1 — I saw this in an error once, is that why?',
    ].join('\r\n');
    expect((await parseMessage(raw)).bounce).toBeNull();
  });

  it('does not read a mailer-daemon message with no permanent code as a bounce', async () => {
    const raw = [
      'From: MAILER-DAEMON@example.net',
      'To: events@example.org',
      'Subject: Warning: message delayed',
      'Message-ID: <w-1@example.net>',
      'Content-Type: text/plain',
      '',
      'Your message has not been delivered yet. We will keep trying.',
    ].join('\r\n');
    expect((await parseMessage(raw)).bounce).toBeNull();
  });
});
