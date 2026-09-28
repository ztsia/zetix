import 'server-only';

import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';

/**
 * One `MailTransport` interface, so an alternative provider is an adapter file
 * rather than a rewrite (spec/email.md §11.1, decision 12).
 *
 * **Every adapter goes through nodemailer's own `createTransport()`, including
 * the test ones.** That is the whole design, and it is not incidental: the
 * message-building code path — MIME assembly, header encoding, base64 of the
 * attachments — is then byte-identical everywhere, and only the final hop
 * differs. A hand-rolled fake would prove nothing about what Gmail receives.
 *
 * Measured, not assumed: the bytes a real SMTP server receives in `DATA` are
 * identical to what `streamTransport` produces, modulo `Message-ID`, `Date` and
 * the multipart boundary.
 */

/** What a caller hands us. Deliberately smaller than nodemailer's own options. */
export type OutgoingMessage = {
  to: string;
  toName?: string | null;
  subject: string;
  /** Rendered Markdown → HTML. The plain-text alternative is derived, never stored. */
  html: string;
  text: string;
  attachments?: OutgoingAttachment[];
  /**
   * The headers that let a reply or a bounce find its way back (spec/v3.md
   * §26.2). All optional, so a caller that does not thread still sends.
   */
  threading?: OutgoingThreading;
};

export type OutgoingThreading = {
  /** Our own `Message-ID`, angle brackets included. Build it with `makeMessageId()`. */
  messageId?: string;
  /** Where a reply should go. The plus-addressed mailbox, from `plusAddress()`. */
  replyTo?: string;
  /** The message this one answers, for a reply a person wrote (§26.6). */
  inReplyTo?: string;
  /** The whole chain, oldest first, ending with `inReplyTo`. */
  references?: string[];
};

export type OutgoingAttachment = {
  filename: string;
  content: Uint8Array;
  contentType: string;
};

/**
 * The normalized result — **the reason this interface exists at all.**
 *
 * nodemailer's `info` is a different shape per transport, and the difference is
 * exactly the part a dispatcher must branch on:
 *
 * | field | real SMTP | `streamTransport` / `jsonTransport` |
 * |---|---|---|
 * | `accepted` / `rejected` | present | **absent** |
 * | `response` | present | **absent** |
 *
 * So `if (info.rejected.length)` throws the first time it meets Gmail, and
 * `info.rejected?.length` is worse — green under test, and in production it
 * reads every Gmail rejection as a success and stamps `ticket_sent_at` on
 * attendees whose mail was refused. That is the precise failure §11.4 exists to
 * prevent, arriving through the test double.
 *
 * Normalising here means no caller ever touches `info` directly.
 */
export type SendResult = {
  /** Recipients the server took responsibility for. Empty is a failure, not a success. */
  accepted: string[];
  rejected: string[];
  /** The server's reply line, where there is one. Stored in `last_error` on failure. */
  response: string | null;
  messageId: string | null;
  /**
   * The bytes that went on the wire, where the transport can report them.
   *
   * Only the test transports fill this in — it is what assertions are made
   * against, and it is why the tests can check MIME structure and encoded size
   * without a network.
   */
  raw: Buffer | null;
};

export interface MailTransport {
  /**
   * The mailbox this transport sends as. Tags are minted against it
   * (`tagging.ts`): our `Message-ID` takes its domain and the plus-addressed
   * `Reply-To` its local part. A transport without one sends untagged.
   */
  readonly sender?: string;
  send(message: OutgoingMessage): Promise<SendResult>;
  /** Closes the pooled connection. Always call it when a batch is done. */
  close(): Promise<void>;
}

/** The `From` header. Gmail rewrites it to the authenticated mailbox otherwise. */
function fromHeader(user: string, displayName: string): string {
  return `"${displayName.replace(/"/g, '')}" <${user}>`;
}

function toNodemailerMessage(message: OutgoingMessage, from: string) {
  const t = message.threading;
  return {
    from,
    ...(t?.messageId ? { messageId: t.messageId } : {}),
    ...(t?.replyTo ? { replyTo: t.replyTo } : {}),
    ...(t?.inReplyTo ? { inReplyTo: t.inReplyTo } : {}),
    ...(t?.references?.length ? { references: t.references } : {}),
    to: message.toName ? `"${message.toName.replace(/"/g, '')}" <${message.to}>` : message.to,
    subject: message.subject,
    text: message.text,
    html: message.html,
    attachments: message.attachments?.map((a) => ({
      filename: a.filename,
      content: Buffer.from(a.content),
      contentType: a.contentType,
    })),
  };
}

/**
 * Normalises whatever nodemailer returned into {@link SendResult}.
 *
 * `accepted` is defaulted to the envelope rather than to `[]`, because a
 * transport that does not report acceptance (the two test ones) did not
 * *reject* anything — treating its silence as a rejection would make every test
 * send look like a failure, which is the mirror image of the bug above.
 */
function normalize(info: unknown, message: OutgoingMessage): SendResult {
  const i = info as Record<string, unknown>;
  const envelopeTo = [message.to];
  const raw = i.message;
  return {
    accepted: Array.isArray(i.accepted) ? (i.accepted as string[]) : envelopeTo,
    rejected: Array.isArray(i.rejected) ? (i.rejected as string[]) : [],
    response: typeof i.response === 'string' ? i.response : null,
    messageId: typeof i.messageId === 'string' ? i.messageId : null,
    raw: Buffer.isBuffer(raw) ? raw : null,
  };
}

function wrap(transporter: Transporter, from: string, sender: string): MailTransport {
  return {
    sender,
    async send(message) {
      const info = await transporter.sendMail(toNodemailerMessage(message, from));
      return normalize(info, message);
    },
    async close() {
      transporter.close();
    },
  };
}

export type SmtpConfig = {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  fromName: string;
};

/**
 * The real transport. Gmail in production, a local SMTP sink in development —
 * **the same code path, differing only in host, port and `secure`**, which is
 * what makes the swap a configuration change rather than a code change.
 *
 * `secure: true` on 465 is implicit TLS; 587 would be `false` plus a STARTTLS
 * upgrade. §11.1 chose 465.
 *
 * **Pooled, with one connection.** Un-pooled nodemailer opens a fresh
 * connection per message — measured: five messages, five connections, five TLS
 * handshakes — and §11.1 costs a send at 1–2s including the handshake, so a
 * batch of `email.max_per_dispatch` would spend most of `maxDuration = 60` in
 * handshakes. One pooled connection for the batch is exactly §11.1's "open,
 * send the batch, close". The "assume no connection reuse" rule in the same
 * section is about reuse *between* function invocations, which a pool inside
 * one invocation does not attempt.
 */
export function createSmtpTransport(config: SmtpConfig): MailTransport {
  const transporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    /**
     * **`auth` is omitted entirely when there is no password**, rather than
     * passed with an empty one.
     *
     * `resolveSmtpConfig()` deliberately allows a blank password for a local
     * sink — the app password is absent from every cloud environment by design
     * — but nodemailer treats the *presence* of `auth` as "authenticate", and
     * refuses with `Missing credentials for "PLAIN"` before it opens a
     * connection. So the documented development path could not send at all, and
     * the transport tests did not catch it because they always pass a password.
     *
     * That path is the one the 400-ticket dry run takes.
     */
    ...(config.pass ? { auth: { user: config.user, pass: config.pass } } : {}),
    pool: true,
    maxConnections: 1,
  });
  return wrap(transporter, fromHeader(config.user, config.fromName), config.user);
}

/**
 * The CI transport: real MIME, no socket.
 *
 * **`streamTransport`, deliberately not `jsonTransport`.** `jsonTransport` does
 * not build MIME at all — it normalises the message and serialises it to JSON,
 * so there is no `Content-Type`, no multipart boundary, no RFC 2047 header
 * encoding and no base64 of the attachments. A test asserting on a subject line
 * containing an em dash passes against it and tells you nothing: the real path
 * sends `=?UTF-8?Q?...?=`. `streamTransport` runs the same MailComposer the SMTP
 * transport does and hands back the finished bytes.
 */
export function createStreamTransport(fromName: string, user: string): MailTransport {
  const transporter = nodemailer.createTransport({ streamTransport: true, buffer: true });
  return wrap(transporter, fromHeader(user, fromName), user);
}
