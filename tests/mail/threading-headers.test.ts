import { describe, expect, it } from 'vitest';
import { parseMessage } from '@/lib/mail/parse';
import { makeMessageId, plusAddress } from '@/lib/mail/tagging';
import { createStreamTransport } from '@/lib/mail/transport';

/**
 * The tags survive MIME composition (spec/v3.md §26.2): what the transport
 * writes is what the parser reads back, through the same nodemailer path the
 * SMTP adapter uses.
 */
describe('threading headers on the wire', () => {
  it('writes our Message-ID, the plus-addressed Reply-To, and the reply chain', async () => {
    const mailbox = 'events@example.org';
    const messageId = makeMessageId(12, mailbox);
    const transport = createStreamTransport('Lakeside Community Orchestra', mailbox);
    const result = await transport.send({
      to: 'guest@guest.example',
      subject: 'Re: A question',
      text: 'Yes, of course.',
      html: '<p>Yes, of course.</p>',
      threading: {
        messageId,
        replyTo: plusAddress(mailbox, { kind: 'registration', id: 9 }),
        inReplyTo: '<CAF=reply-1@mail.guest.example>',
        references: ['<9.aaaa@example.org>', '<CAF=reply-1@mail.guest.example>'],
      },
    });
    await transport.close();

    expect(result.messageId).toBe(messageId);
    const back = await parseMessage(result.raw!);
    expect(back.messageId).toBe(messageId);
    expect(back.inReplyTo).toBe('<CAF=reply-1@mail.guest.example>');
    expect(back.references).toEqual(['<9.aaaa@example.org>', '<CAF=reply-1@mail.guest.example>']);
    expect(result.raw!.toString()).toMatch(/^Reply-To: events\+p9@example\.org\r?$/m);
  });

  it('sends without any of them, as before', async () => {
    const transport = createStreamTransport('Lakeside Community Orchestra', 'events@example.org');
    const result = await transport.send({ to: 'guest@guest.example', subject: 's', text: 't', html: '<p>t</p>' });
    await transport.close();
    expect(result.raw!.toString()).not.toMatch(/^(Reply-To|In-Reply-To|References):/im);
  });
});
