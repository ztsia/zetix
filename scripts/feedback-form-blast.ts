/**
 * One-off blast of a **Google Forms feedback link** to everyone who was
 * admitted to a show.
 *
 *   pnpm email:form-blast --show=5                       # dry run (the default)
 *   pnpm email:form-blast --show=5 --to=me@example.com   # send yourself a copy
 *   pnpm email:form-blast --show=5 --send                # the real thing
 *
 * **Why this is a script and not the feedback blast in the admin UI.**
 * `lib/email/feedback-blast.ts` sends one message per *registration* carrying
 * one `/t/{token}` portal link per *admitted seat* — the native V2 feedback
 * form. This sends one message per *email address* carrying one link that is
 * the same for everybody, because the form for this round lives in Google Forms
 * and has no notion of who is answering. The two are different messages with
 * different audiences, and neither is a flag on the other.
 *
 * **Runs locally, against whatever `DATABASE_URL` points at.** It is not wired
 * into the app, has no route, and nothing schedules it.
 *
 * `--conditions=react-server` is not decoration: `lib/email/transport.ts` and
 * `lib/email/config.ts` are `server-only`, and that package throws on import
 * under plain Node. The condition is what lets this script send through the
 * *same* transport and the *same* renderer production uses, so the MIME that
 * leaves here is the MIME the dry run showed you. `pnpm email:form-blast`
 * passes it; calling `tsx scripts/feedback-form-blast.ts` directly will not.
 */
import './load-env';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getSql } from '../src/db/client';
import { createConfiguredTransport } from '../src/lib/email/config';
import { markdownToEmailHtml, markdownToPlainText } from '../src/lib/email/render';
import { formatInZone } from '../src/lib/email/queue';
import { toNameCase } from '../src/lib/names';

/**
 * **The link, hardcoded — paste the Google Forms URL here before sending.**
 *
 * Deliberately a constant rather than a setting: it is not an operational value
 * of the kind §2.1 keeps out of code (no capacity, quota, deadline or cap), it
 * belongs to one form for one round, and it is the single thing in this file
 * that has to be right. A wrong one is two hundred emails pointing at nothing,
 * so the script refuses to send while it still reads the placeholder, prints
 * the URL in full before every send, and takes `--form-url=` so a test does not
 * need anyone to edit the file.
 */
const FORM_URL =
  'https://docs.google.com/forms/d/e/EXAMPLE_FORM_ID/viewform?usp=header';

const PLACEHOLDER = 'PASTE_THE_GOOGLE_FORM_URL_HERE';

/**
 * The ledger key. `email_outbox.template_key` is free text with no foreign key,
 * and the admin email screens filter to their own known keys, so a row written
 * under this one is invisible there rather than broken.
 *
 * **This is what makes a second run safe.** There is no `ticket_sent_at`
 * equivalent for a message that carries no ticket, so "has this address already
 * had it?" is answered by asking for a SENT row under this key against any
 * registration sharing the address.
 */
const TEMPLATE_KEY = 'feedback_form_link';

type Recipient = {
  email: string;
  name: string | null;
  /** The registration the ledger row hangs off — the earliest of this address's. */
  representativeId: number;
  /** Every admitted registration this address holds. One email covers all of them. */
  registrationIds: number[];
  admittedSeats: number;
};

type ShowContext = {
  showId: number;
  showName: string;
  concertName: string;
  startsAt: string | null;
  timezone: string;
};

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return undefined;
  const value = hit.slice(`--${name}=`.length);
  return hit.includes('=') ? value : '';
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function footerFor(show: ShowContext): string {
  return `You are receiving this because you attended ${show.concertName}.`;
}

/**
 * The date, without the time.
 *
 * Deliberately not `formatInZone`, which the ticket messages share: those are
 * read *before* the show and the start time is the point of them. This one is
 * read afterwards, and "on Saturday, 19 September 2026 at 20:00" tells someone
 * who was in the hall something they already know, in a sentence that only
 * needs to place the evening.
 */
function formatDateInZone(value: string | null, timezone: string): string {
  if (!value) return '';
  return new Intl.DateTimeFormat('en-GB', { dateStyle: 'full', timeZone: timezone }).format(
    new Date(value),
  );
}

/**
 * The message. **Identical for everybody but the greeting**, which is why there
 * are no merge tokens and no `renderTemplate` call here: there is nothing per
 * recipient to get wrong, and an unknown token cannot render blank into two
 * hundred inboxes because there are none.
 */
function body(show: ShowContext, formUrl: string, name: string | null): string {
  const when = formatDateInZone(show.startsAt, show.timezone);
  return [
    name ? `Dear ${name},` : 'Dear friend,',
    '',
    `Thank you for coming to **${show.concertName}**${when ? ` on ${when}` : ''}.`,
    '',
    'We would love to know how you found the evening. It takes about two minutes,',
    'and we would truly appreciate your feedback.',
    '',
    `[Share your feedback](${formUrl})`,
    '',
    'If that link does not open, copy this into your browser:',
    '',
    formUrl,
    '',
    'With thanks,',
    'Lakeside Community Orchestra',
  ].join('\n');
}

/** Both halves of the message, rendered the way the dispatcher renders them. */
function renderMessage(show: ShowContext, bodyMd: string) {
  return {
    html: markdownToEmailHtml(bodyMd, {
      preheader: markdownToPlainText(bodyMd).split('\n')[0],
      footer: footerFor(show),
    }),
    text: markdownToPlainText(bodyMd),
  };
}

function subjectFor(show: ShowContext): string {
  return `How was ${show.concertName}?`;
}

async function loadShow(showId: number): Promise<ShowContext> {
  const rows = await getSql()<
    { name: string; starts_at: string | null; concert_name: string; timezone: string | null }[]
  >`
    select s.name, s.starts_at, c.name as concert_name, c.timezone
      from shows s join concerts c on c.id = s.concert_id
     where s.id = ${showId} and s.deleted_at is null
  `;
  const row = rows[0];
  if (!row) throw new Error(`No show ${showId}.`);
  // The same refusal the native blast makes: without a zone there is no such
  // thing as a show time, and a date rendered in the runner's zone is worse
  // than no date at all.
  if (!row.timezone) throw new Error(`The concert for show ${showId} has no timezone set.`);
  return {
    showId,
    showName: row.name,
    concertName: row.concert_name,
    startsAt: row.starts_at,
    timezone: row.timezone,
  };
}

/**
 * **Admitted, deduplicated by address.**
 *
 * The audience predicate is the one `feedback-blast.ts` documents: a CONFIRMED
 * seat with a live `check_ins` row, which counts a manual admit and an override
 * alike and excludes a reverted scan. Anyone who registered and did not come
 * gets nothing.
 *
 * The grouping is the part that differs, and it is the whole request: an
 * address that booked six times is one email, not six. The representative is
 * the earliest registration, so the choice is stable across runs and the ledger
 * row the first run wrote is the row the second run looks for.
 */
async function loadRecipients(showId: number): Promise<{ all: Recipient[]; skipped: number }> {
  const rows = await getSql()<
    {
      email: string;
      name: string | null;
      representative_id: number;
      registration_ids: number[];
      admitted_seats: number;
      already_sent: boolean;
    }[]
  >`
    with came as (
      select r.id,
             lower(r.contact_email) as email,
             r.contact_name,
             r.requested_at,
             (select count(*)
                from attendees a
               where a.registration_id = r.id
                 and a.status = 'CONFIRMED'
                 and a.deleted_at is null
                 and exists (select 1 from check_ins k
                              where k.attendee_id = a.id and k.reverted_at is null)
             )::int as seats
        from registrations r
       where r.show_id = ${showId}
         and r.status = 'CONFIRMED'
         and r.deleted_at is null
    )
    select c.email,
           -- The name on the earliest of this address's registrations, ordered
           -- exactly as the id below is, so the greeting and the ledger row can
           -- never come from different registrations.
           (array_agg(c.contact_name order by c.requested_at, c.id))[1] as name,
           (array_agg(c.id order by c.requested_at, c.id))[1]::int as representative_id,
           array_agg(c.id order by c.id)::int[] as registration_ids,
           sum(c.seats)::int as admitted_seats,
           -- Asked per address rather than per registration: the point of the
           -- dedupe is that any one of this address's registrations having been
           -- emailed means the person already has the link.
           exists (
             select 1 from email_outbox o
               join registrations r2 on r2.id = o.registration_id
              where o.template_key = ${TEMPLATE_KEY}
                and o.status = 'SENT'
                and lower(r2.contact_email) = c.email
           ) as already_sent
      from came c
     where c.seats > 0
     group by c.email
     order by min(c.requested_at), min(c.id)
  `;

  const all = rows
    .filter((row) => !row.already_sent)
    .map((row) => ({
      email: row.email,
      name: row.name ? toNameCase(row.name) : null,
      representativeId: Number(row.representative_id),
      registrationIds: row.registration_ids.map(Number),
      admittedSeats: Number(row.admitted_seats),
    }));

  return { all, skipped: rows.length - all.length };
}

/** How many messages this account has already put on the wire today. */
async function sentInLast24h(): Promise<number> {
  const rows = await getSql()<{ n: number }[]>`
    select count(*)::int as n from email_outbox
     where status = 'SENT' and sent_at > now() - interval '24 hours'
  `;
  return rows[0]?.n ?? 0;
}

/** Both of these are operational values and resolve through the cascade (§2.1). */
async function setting(show: ShowContext, key: string): Promise<number> {
  const rows = await getSql()<{ value: unknown }[]>`
    select resolve_setting(${key}, null, s.id, s.concert_id) as value
      from shows s where s.id = ${show.showId}
  `;
  const value = Number(rows[0]?.value);
  if (!Number.isFinite(value)) throw new Error(`${key} does not resolve.`);
  return value;
}

/**
 * Records the outcome so a re-run skips this address.
 *
 * **Written after the server accepted, never before.** The window for a
 * duplicate is then one message wide — a crash between Gmail's acceptance and
 * this insert — instead of the whole run. A FAILED row is recorded too, and is
 * deliberately *not* treated as covered, so a re-run picks it up.
 */
async function record(
  recipient: Recipient,
  show: ShowContext,
  formUrl: string,
  subject: string,
  bodyMd: string,
  outcome: { ok: true; response: string | null } | { ok: false; error: string },
) {
  await getSql()`
    insert into email_outbox (
      registration_id, template_key, to_email, to_name, subject, body_md, context,
      status, attempts, last_error, sent_at
    ) values (
      ${recipient.representativeId}, ${TEMPLATE_KEY}, ${recipient.email},
      ${recipient.name}, ${subject}, ${bodyMd},
      ${JSON.stringify({
        form_url: formUrl,
        show_id: show.showId,
        // Every registration this one message stood in for, so the dedupe is
        // auditable after the fact rather than merely reproducible.
        covered_registration_ids: recipient.registrationIds,
        admitted_seats: recipient.admittedSeats,
        response: outcome.ok ? outcome.response : null,
      })}::jsonb,
      ${outcome.ok ? 'SENT' : 'FAILED'}, 1,
      ${outcome.ok ? null : outcome.error},
      ${outcome.ok ? new Date().toISOString() : null}::timestamptz
    )
  `;
}

async function main() {
  const showId = Number(arg('show'));
  if (!Number.isInteger(showId)) {
    console.error('Which show? e.g. --show=5');
    process.exit(1);
  }

  const formUrl = arg('form-url') || FORM_URL;
  const send = flag('send');
  const testTo = (arg('to') ?? '')
    .split(',')
    .map((a) => a.trim())
    .filter(Boolean);
  const limitArg = arg('limit');
  const limit = limitArg ? Number(limitArg) : Infinity;
  const greetByName = !flag('no-name');

  const show = await loadShow(showId);
  const subject = subjectFor(show);
  const sampleBody = body(show, formUrl, greetByName ? 'Sample Recipient' : null);

  console.log(`\n  ${show.concertName} — ${show.showName}`);
  console.log(`  ${formatInZone(show.startsAt, show.timezone)} (${show.timezone})`);
  console.log(`  Form link: ${formUrl}`);
  if (formUrl === PLACEHOLDER) {
    console.log('  ^ not filled in — edit FORM_URL at the top of this script, or pass --form-url=');
  } else if (!formUrl.startsWith('https://')) {
    console.log('  ^ that is not an https URL. Check it before sending.');
  }
  console.log(`  Subject: ${subject}`);
  console.log(`  Greeting: ${greetByName ? 'personalised from contact_name' : 'generic (--no-name)'}\n`);

  const previewPath = join(tmpdir(), `feedback-form-blast-show-${showId}.html`);
  writeFileSync(previewPath, renderMessage(show, sampleBody).html);
  console.log(`  HTML preview written to ${previewPath}\n`);
  console.log(markdownToPlainText(sampleBody).replace(/^/gm, '  | '));
  console.log('');

  // ---- test send: the exact message, to addresses you name, ledger untouched
  if (testTo.length > 0) {
    if (formUrl === PLACEHOLDER) {
      console.error('Refusing to send a placeholder link, even to you.');
      process.exit(1);
    }
    const transport = createConfiguredTransport();
    try {
      for (const to of testTo) {
        const rendered = renderMessage(show, sampleBody);
        const result = await transport.send({ to, subject, ...rendered });
        console.log(
          result.accepted.length > 0
            ? `  test → ${to}  accepted`
            : `  test → ${to}  REFUSED: ${result.response ?? 'no reason given'}`,
        );
      }
    } finally {
      await transport.close();
    }
    console.log('\n  Nothing was written to email_outbox — a test send is not a record of anything.\n');
    await getSql().end();
    return;
  }

  // ---- the audience
  const { all, skipped } = await loadRecipients(showId);
  const recipients = Number.isFinite(limit) ? all.slice(0, limit) : all;
  const seats = recipients.reduce((n, r) => n + r.admittedSeats, 0);
  const merged = all.filter((r) => r.registrationIds.length > 1);

  console.log(`  ${all.length} address(es) to write to, covering ${seats} admitted seat(s).`);
  console.log(
    `  ${merged.length} of them registered more than once — one email each, not ` +
      `${merged.reduce((n, r) => n + r.registrationIds.length, 0)}.`,
  );
  if (skipped > 0) console.log(`  ${skipped} already had this message on an earlier run, and are skipped.`);
  if (recipients.length < all.length) {
    console.log(`  --limit=${limit}: this run would take the first ${recipients.length}.`);
  }

  const cap = await setting(show, 'email.max_per_day');
  const already = await sentInLast24h();
  console.log(`  Sent from this account in the last 24h: ${already}. email.max_per_day resolves to ${cap}.`);
  if (already + recipients.length > cap) {
    console.error(
      `\n  That would put ${already + recipients.length} messages through the account in a day, ` +
        `over the ${cap} the cascade allows.\n  Split it with --limit= and finish tomorrow.\n`,
    );
    process.exit(1);
  }

  if (!send) {
    console.log('\n  First ten:');
    for (const r of recipients.slice(0, 10)) {
      const extra = r.registrationIds.length > 1 ? `, ${r.registrationIds.length} registrations` : '';
      console.log(
        `    ${r.email.padEnd(38)} ${(r.name ?? '(no name)').padEnd(26)} ${r.admittedSeats} seat(s)${extra}`,
      );
    }
    console.log('\n  DRY RUN — nothing sent, nothing written.');
    console.log('  Send yourself one first:  --to=you@example.com');
    console.log('  Then, for real:           --send\n');
    await getSql().end();
    return;
  }

  // ---- the real thing
  if (formUrl === PLACEHOLDER) {
    console.error('Refusing to send a placeholder link to a live audience.');
    process.exit(1);
  }
  if (recipients.length === 0) {
    console.log('\n  Nobody left to write to.\n');
    await getSql().end();
    return;
  }

  const delay = await setting(show, 'email.inter_message_delay_ms');
  console.log(
    `\n  SENDING to ${recipients.length} address(es), ${delay}ms apart, pointing at\n  ${formUrl}`,
  );
  // The only gate between here and somebody's inbox. Five seconds is enough to
  // read the URL above and press Ctrl-C.
  for (let i = 5; i > 0; i -= 1) {
    process.stdout.write(`\r  starting in ${i}...  (Ctrl-C to stop) `);
    await sleep(1000);
  }
  console.log('\n');

  const transport = createConfiguredTransport();
  let sent = 0;
  let failed = 0;
  try {
    for (const [index, recipient] of recipients.entries()) {
      const bodyMd = body(show, formUrl, greetByName ? recipient.name : null);
      const label = `[${index + 1}/${recipients.length}] ${recipient.email}`;
      try {
        const result = await transport.send({
          to: recipient.email,
          toName: recipient.name,
          subject,
          ...renderMessage(show, bodyMd),
        });
        // A server that accepted nobody has not delivered, whatever else it
        // said — the same rule the dispatcher applies, for the same reason.
        if (result.accepted.length === 0) {
          throw new Error(result.response ?? 'The server accepted no recipients.');
        }
        await record(recipient, show, formUrl, subject, bodyMd, {
          ok: true,
          response: result.response,
        });
        sent += 1;
        console.log(`  ${label}  sent`);
      } catch (error) {
        failed += 1;
        const message = error instanceof Error ? error.message : String(error);
        await record(recipient, show, formUrl, subject, bodyMd, { ok: false, error: message });
        console.log(`  ${label}  FAILED: ${message}`);
      }
      if (index < recipients.length - 1) await sleep(delay);
    }
  } finally {
    await transport.close();
  }

  console.log(`\n  ${sent} sent, ${failed} failed.`);
  if (failed > 0) {
    console.log('  Re-run to retry the failures — a FAILED row does not count as covered.');
  }
  console.log('');
  await getSql().end();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
