import 'server-only';

import { requireSetting } from '@/db/settings';
import { configuredMailbox, connectConfiguredInbox, MailNotConfiguredError } from '@/lib/email/config';
import type { MailInbox } from '@/lib/mail/inbox';
import { errorText, syncMailbox, type SyncReport } from './sync';

export type InboxRunResult =
  | ({ status: 'synced' } & SyncReport)
  | { status: 'not_configured'; reason: string }
  | { status: 'failed'; error: string };

export type InboxRunOptions = {
  /**
   * The latest moment the sync may start a message (epoch ms). The caller's
   * own ceiling; the sync takes the earlier of it and `inbox.sync_budget_seconds`
   * from now.
   */
  deadline?: number;
  /** Injected by tests; production connects to the configured mailbox. */
  inbox?: MailInbox;
  mailbox?: string;
};

/**
 * One inbox sync with the app's configuration (spec/v3.md §26.3): the mailbox
 * the transport sends as, `inbox.sync_budget_seconds` of time and
 * `inbox.match_fallback_days` of window, both resolved through the cascade.
 *
 * **It never throws.** It runs inside the scheduler tick after sending and
 * command runs, and inside a page's background refresh; either would be worse
 * off failing because the mailbox is unreachable. The result says what happened.
 * An environment with no mail credential — every cloud and CI one — reports
 * `not_configured`, which is a state rather than an error.
 */
export async function runInboxSync(options: InboxRunOptions = {}): Promise<InboxRunResult> {
  let inbox: MailInbox | undefined = options.inbox;
  try {
    const mailbox = options.mailbox ?? configuredMailbox();
    if (!mailbox) return { status: 'not_configured', reason: 'GMAIL_USER is not set.' };

    const [budgetSeconds, fallbackDays] = await Promise.all([
      requireSetting<number>('inbox.sync_budget_seconds'),
      requireSetting<number>('inbox.match_fallback_days'),
    ]);
    const deadline = Math.min(options.deadline ?? Infinity, Date.now() + budgetSeconds * 1000);
    if (Date.now() >= deadline) return { status: 'synced', folders: [] };

    inbox ??= await connectConfiguredInbox();
    const report = await syncMailbox({ inbox, mailbox, deadline, fallbackDays });
    return { status: 'synced', ...report };
  } catch (error) {
    if (error instanceof MailNotConfiguredError) return { status: 'not_configured', reason: error.message };
    return { status: 'failed', error: errorText(error) };
  } finally {
    // Only a connection this call opened is this call's to close.
    if (inbox && !options.inbox) await inbox.close().catch(() => {});
  }
}
