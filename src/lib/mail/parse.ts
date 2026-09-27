import { simpleParser, type AddressObject, type ParsedMail } from 'mailparser';
import { sanitizeMailHtml } from './sanitize';
import { normalizeMessageId, parseMessageIdList } from './tagging';

/**
 * One raw message, read into the fields the inbox matches and stores
 * (spec/v3.md §26.3–§26.4). Nothing here decides *who* a message belongs to;
 * it only reads what the message says about itself.
 */
export type ParsedMessage = {
  /** Normalised `<id>`, or null when the message carries none. */
  messageId: string | null;
  inReplyTo: string | null;
  /** The `References` chain, oldest first. */
  references: string[];
  from: { address: string; name: string | null } | null;
  /** Every recipient address the message names: `To`, `Cc`, `Delivered-To`, `X-Original-To`. */
  recipients: string[];
  /** `To` alone, for display. */
  to: string | null;
  subject: string | null;
  text: string | null;
  /** Sanitised before it leaves this module (`sanitize.ts`). */
  html: string | null;
  date: Date | null;
  /**
   * Written by software, not a person: an out-of-office or other auto-reply
   * (RFC 3834 `Auto-Submitted`, and the older headers clients still send).
   */
  autoReply: boolean;
  /** Set when the message is a delivery-status notification (§26.4). */
  bounce: BounceReport | null;
};

/**
 * What a delivery-status notification says about the message it reports on.
 *
 * `action` is the RFC 3464 field. **Only `failed` is a bounce.** Gmail sends
 * `delayed` notices for a message it is still retrying, and treating one as a
 * bounce would flag a party whose tickets arrive an hour later.
 */
export type BounceReport = {
  action: 'failed' | 'delayed' | 'delivered' | 'relayed' | 'expanded' | 'unknown';
  /** The quoted original's `Message-ID` — how the bounce finds our outbox row. */
  originalMessageId: string | null;
  recipient: string | null;
  /** The enhanced status code, e.g. `5.1.1`. */
  status: string | null;
  diagnostic: string | null;
};

const DAEMON_LOCALS = new Set(['mailer-daemon', 'postmaster', 'mail-daemon']);

/** RFC 822 header blocks fold long values onto indented lines; this unfolds them. */
function unfold(block: string): string {
  return block.replace(/\r\n/g, '\n').replace(/\n[ \t]+/g, ' ');
}

function headerField(block: string, name: string): string | null {
  const re = new RegExp(`^${name}:[ \\t]*(.*)$`, 'im');
  const match = re.exec(unfold(block));
  return match ? match[1].trim() : null;
}

/**
 * The `message/delivery-status` body, read from the raw source.
 *
 * mailparser folds that part into `text` rather than exposing it, which is
 * fine to read from but mixes it with the human-readable half. Reading the part
 * itself keeps a "Status: 5.1.1" in a guest's own prose from ever looking like
 * a report field. Falls back to `null`, and the caller then reads `text`.
 */
function deliveryStatusPart(raw: string): string | null {
  const source = raw.replace(/\r\n/g, '\n');
  const header = /^content-type:[ \t]*message\/(?:global-)?delivery-status\b[^\n]*(?:\n[ \t][^\n]*)*\n/im.exec(
    source,
  );
  if (!header) return null;
  const rest = source.slice(header.index + header[0].length);
  // Skip the remainder of the part's own headers, up to the blank line.
  const bodyStart = rest.indexOf('\n\n');
  const body = bodyStart === -1 ? rest : rest.slice(bodyStart + 2);
  const end = body.search(/^--[^\n]+$/m);
  return end === -1 ? body : body.slice(0, end);
}

/** The recipient block of a delivery-status report that says what happened. */
function readReport(report: string): Omit<BounceReport, 'originalMessageId'> & { xOriginal: string | null } {
  // Per-message fields come first, then one block per recipient, separated by blank lines.
  const blocks = unfold(report).split(/\n\s*\n/).filter((b) => b.trim().length > 0);
  const xOriginal = normalizeMessageId(headerField(blocks.join('\n'), 'X-Original-Message-ID'));
  const recipientBlocks = blocks.filter((b) => headerField(b, 'Action') !== null);
  // Prefer the block that failed: one report can cover a failed and a delivered recipient.
  const chosen =
    recipientBlocks.find((b) => headerField(b, 'Action')?.toLowerCase() === 'failed') ?? recipientBlocks[0];
  if (!chosen) {
    return { action: 'unknown', recipient: null, status: null, diagnostic: null, xOriginal };
  }
  const actionRaw = (headerField(chosen, 'Action') ?? '').toLowerCase();
  const action = (['failed', 'delayed', 'delivered', 'relayed', 'expanded'] as const).find(
    (a) => a === actionRaw,
  );
  const recipientRaw = headerField(chosen, 'Final-Recipient') ?? headerField(chosen, 'Original-Recipient');
  const diagnosticRaw = headerField(chosen, 'Diagnostic-Code');
  return {
    action: action ?? 'unknown',
    recipient: recipientRaw ? recipientRaw.replace(/^[^;]*;\s*/, '').trim() || null : null,
    status: headerField(chosen, 'Status')?.split(/\s/)[0] ?? null,
    // "smtp; 550-5.1.1 The email account…" — the type prefix is noise to a reader.
    diagnostic: diagnosticRaw ? diagnosticRaw.replace(/^[a-z-]+;\s*/i, '').replace(/\s+/g, ' ').trim() : null,
    xOriginal,
  };
}

/** The `Message-ID` of the original, from a quoted `message/rfc822` or `text/rfc822-headers` part. */
function quotedOriginalId(mail: ParsedMail): string | null {
  for (const attachment of mail.attachments) {
    const type = attachment.contentType.toLowerCase();
    if (type === 'message/rfc822' || type === 'text/rfc822-headers' || type === 'message/global') {
      const source = attachment.content.toString('utf8');
      const headersOnly = source.split(/\r?\n\r?\n/)[0] ?? '';
      const id = normalizeMessageId(headerField(headersOnly, 'Message-ID'));
      if (id) return id;
    }
  }
  return null;
}

function isDaemon(address: string | undefined): boolean {
  if (!address) return false;
  return DAEMON_LOCALS.has(address.split('@')[0]?.toLowerCase() ?? '');
}

function addresses(field: AddressObject | AddressObject[] | undefined): string[] {
  if (!field) return [];
  const list = Array.isArray(field) ? field : [field];
  return list.flatMap((o) => o.value.map((v) => v.address).filter((a): a is string => !!a));
}

function headerAddresses(mail: ParsedMail, name: string): string[] {
  const value = mail.headers.get(name) as unknown;
  if (!value) return [];
  // mailparser returns address-like headers as a string, a list, or a parsed
  // address object depending on the header; its `text` is the source either way.
  const text =
    typeof value === 'string'
      ? value
      : Array.isArray(value)
        ? value.map((v) => (typeof v === 'string' ? v : ((v as { text?: string }).text ?? ''))).join(',')
        : ((value as { text?: string }).text ?? '');
  return (text.match(/[^\s<>,;"]+@[^\s<>,;"]+/g) ?? []).map((a) => a.trim());
}

function readBounce(mail: ParsedMail, raw: string): BounceReport | null {
  const contentType = mail.headers.get('content-type') as { value?: string; params?: Record<string, string> } | undefined;
  const isReport =
    contentType?.value?.toLowerCase() === 'multipart/report' &&
    (contentType.params?.['report-type'] ?? '').toLowerCase() === 'delivery-status';
  const fromDaemon = isDaemon(mail.from?.value[0]?.address);
  if (!isReport && !fromDaemon) return null;

  const part = deliveryStatusPart(raw) ?? (isReport ? mail.text ?? '' : '');
  const report = part ? readReport(part) : null;

  const originalMessageId =
    quotedOriginalId(mail) ??
    report?.xOriginal ??
    // Gmail's own notices thread under the original as well.
    normalizeMessageId(mail.inReplyTo) ??
    parseMessageIdList(mail.references ?? null).at(-1) ??
    // A non-standard notice that pastes the headers into its prose.
    normalizeMessageId(/^\s*Message-ID:\s*(<[^>\s]+>)/im.exec(mail.text ?? '')?.[1]);

  if (!report || report.action === 'unknown') {
    // A mailer-daemon message with no machine-readable report. It is a bounce
    // only if it says so in the one way that is not prose: a permanent code.
    const enhanced = /\b5\.\d{1,3}\.\d{1,3}\b/.exec(mail.text ?? '');
    const permanent = enhanced ?? /\b55\d\b/.exec(mail.text ?? '');
    if (!permanent && !isReport) return null;
    return {
      action: permanent ? 'failed' : 'unknown',
      originalMessageId,
      recipient: report?.recipient ?? headerAddresses(mail, 'x-failed-recipients')[0] ?? null,
      status: report?.status ?? enhanced?.[0] ?? null,
      diagnostic: report?.diagnostic ?? null,
    };
  }

  return {
    action: report.action,
    originalMessageId,
    recipient: report.recipient ?? headerAddresses(mail, 'x-failed-recipients')[0] ?? null,
    status: report.status,
    diagnostic: report.diagnostic,
  };
}

function headerText(mail: ParsedMail, name: string): string {
  const value = mail.headers.get(name) as unknown;
  if (typeof value === 'string') return value.toLowerCase();
  if (value && typeof value === 'object' && 'value' in value) return String((value as { value: unknown }).value).toLowerCase();
  return '';
}

function isAutoReply(mail: ParsedMail): boolean {
  const submitted = headerText(mail, 'auto-submitted');
  if (submitted && submitted !== 'no') return true;
  if (mail.headers.has('x-autoreply') || mail.headers.has('x-autorespond')) return true;
  return ['auto_reply', 'auto-reply'].includes(headerText(mail, 'precedence'));
}

export async function parseMessage(raw: Buffer | string): Promise<ParsedMessage> {
  const source = typeof raw === 'string' ? raw : raw.toString('utf8');
  const mail = await simpleParser(raw, { skipImageLinks: true, skipTextToHtml: true });

  const from = mail.from?.value[0];
  const to = addresses(mail.to);
  const recipients = [
    ...to,
    ...addresses(mail.cc),
    ...headerAddresses(mail, 'delivered-to'),
    ...headerAddresses(mail, 'x-original-to'),
  ];

  const html = typeof mail.html === 'string' ? mail.html : null;
  return {
    messageId: normalizeMessageId(mail.messageId),
    inReplyTo: normalizeMessageId(mail.inReplyTo),
    references: parseMessageIdList(mail.references ?? null),
    from: from?.address ? { address: from.address, name: from.name || null } : null,
    recipients: [...new Set(recipients.map((a) => a.toLowerCase()))],
    to: to.length > 0 ? to.join(', ') : null,
    subject: mail.subject ?? null,
    text: mail.text?.trim() || null,
    html: sanitizeMailHtml(html),
    date: mail.date && !Number.isNaN(mail.date.getTime()) ? mail.date : null,
    autoReply: isAutoReply(mail),
    bounce: readBounce(mail, source),
  };
}
