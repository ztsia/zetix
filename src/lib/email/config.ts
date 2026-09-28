import 'server-only';

import { env } from '@/lib/env';
import { connectImap, type ImapConfig } from '@/lib/mail/imap';
import type { MailInbox } from '@/lib/mail/inbox';
import { createSmtpTransport, type MailTransport, type SmtpConfig } from '@/lib/mail/transport';

/**
 * Where the transport points, and the one place Gmail's coordinates are written
 * (spec/email.md §11.1).
 *
 * These are not operational values — no capacity, quota, deadline or cap, and
 * nothing from `context.md`. Batch size, inter-message delay and the daily cap
 * are operational and resolve through the cascade instead
 * (`email.max_per_dispatch`, `email.inter_message_delay_ms`,
 * `email.max_per_day`).
 */
export const GMAIL_HOST = 'smtp.gmail.com';

/**
 * 465 with implicit TLS, as §11.1 chose. 587 would work too, as `secure: false`
 * plus a STARTTLS upgrade; only **port 25** is blocked on serverless, which is
 * the source of the widely-repeated claim that SMTP does not work on Lambda.
 */
export const GMAIL_PORT = 465;

/** The display name on every message. */
export const FROM_NAME = 'Lakeside Community Orchestra';

export class MailNotConfiguredError extends Error {
  constructor(missing: string) {
    super(
      `${missing} is not set, so no mail can be sent. In production set the Gmail ` +
        'app password; in development point SMTP_HOST and SMTP_PORT at a local ' +
        'sink instead (local.md §7).',
    );
    this.name = 'MailNotConfiguredError';
  }
}

/**
 * **Google displays an app password as four space-separated groups of four**,
 * and a pasted `abcd efgh ijkl mnop` authenticates as a 19-character password
 * that Gmail refuses with a bare `535`. Nothing else in the stack would say
 * why, so the spaces come off here rather than in a runbook.
 */
export function normalizeAppPassword(raw: string): string {
  return raw.replace(/\s+/g, '');
}

export function resolveSmtpConfig(): SmtpConfig {
  const e = env();

  const user = e.GMAIL_USER;
  if (!user) throw new MailNotConfiguredError('GMAIL_USER');

  /**
   * The swap the whole adapter design exists for: an override points the same
   * code path at a sink on `127.0.0.1`, and unset means Gmail. Host, port and
   * `secure` are the only three things that differ between them.
   */
  const host = e.SMTP_HOST ?? GMAIL_HOST;
  const port = e.SMTP_PORT ?? GMAIL_PORT;
  const secure = e.SMTP_SECURE ?? port === 465;

  /**
   * A sink needs no credential, and requiring one would make the development
   * path impossible — the app password is deliberately absent from every cloud
   * environment (`local.md` §7). Gmail always needs one.
   */
  const isOverridden = e.SMTP_HOST !== undefined;
  const pass = e.GMAIL_APP_PASSWORD ? normalizeAppPassword(e.GMAIL_APP_PASSWORD) : '';
  if (!pass && !isOverridden) throw new MailNotConfiguredError('GMAIL_APP_PASSWORD');

  return { host, port, secure, user, pass, fromName: FROM_NAME };
}

export function createConfiguredTransport(): MailTransport {
  return createSmtpTransport(resolveSmtpConfig());
}

/** Gmail's IMAP, implicit TLS (spec/v3.md §26.3). */
export const GMAIL_IMAP_HOST = 'imap.gmail.com';
export const GMAIL_IMAP_PORT = 993;

/**
 * Where the inbox sync reads from — the same account the transport sends as.
 *
 * Throws {@link MailNotConfiguredError} exactly as the transport does when the
 * credential is absent, which is the normal state of every cloud and CI
 * environment; the sync reports that as "not configured" rather than failing
 * the tick it runs in.
 */
export function resolveImapConfig(): ImapConfig {
  const e = env();
  const user = e.GMAIL_USER;
  if (!user) throw new MailNotConfiguredError('GMAIL_USER');

  const host = e.IMAP_HOST ?? GMAIL_IMAP_HOST;
  const port = e.IMAP_PORT ?? GMAIL_IMAP_PORT;
  const secure = e.IMAP_SECURE ?? port === 993;
  const isOverridden = e.IMAP_HOST !== undefined;
  const pass = e.GMAIL_APP_PASSWORD ? normalizeAppPassword(e.GMAIL_APP_PASSWORD) : '';
  if (!pass && !isOverridden) throw new MailNotConfiguredError('GMAIL_APP_PASSWORD');

  return { host, port, secure, user, pass, connectTimeoutMs: 10_000 };
}

/** The mailbox tags are minted for and replies are matched against. */
export function configuredMailbox(): string | null {
  return env().GMAIL_USER ?? null;
}

export function connectConfiguredInbox(): Promise<MailInbox> {
  return connectImap(resolveImapConfig());
}
