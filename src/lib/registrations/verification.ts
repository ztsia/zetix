import 'server-only';
import { randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Executor } from '@/db/allocation';
import { getDb } from '@/db/client';
import { escapeMergeValues, renderTemplate } from '@/lib/email/render';
import { templateFor } from '@/lib/email/template-row';

/**
 * Double opt-in for the public form (spec/v2.md §8.1.4).
 *
 * **Verification gates the email, never the seat.** The registration is
 * `CONFIRMED` the moment it is submitted, because seats are scarce and holding
 * them for an unclicked link gives them away to the next person in the queue.
 * What waits is the ticket email, and `queue.ts`'s `IS_VERIFIED` is where that
 * waiting actually happens.
 *
 * **Only a registration that was sent a link is gated**, and the schema says so
 * with one nullable column: a registration with no `verification_token` has
 * nothing to wait for. That is what makes the two exemptions fall out rather
 * than needing rules of their own —
 *
 * - **`source = IMPORT` skips verification entirely.** An imported registrant
 *   never received a link. Get this wrong and the 19 Sep cohort loses its
 *   tickets.
 * - **Player forms do not verify.** The address came from the roster, not from
 *   a stranger typing it.
 *
 * — because neither path ever calls {@link issueVerificationToken}.
 */

/**
 * Unguessable, like `players.invite_token` and `qr_token` before it.
 *
 * 32 bytes of `randomBytes` in base64url. Possession of this token is what
 * proves someone reads the address, so it has to be worth nothing to guess;
 * `Math.random()` would make the whole gate decorative.
 */
export function mintVerificationToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * The URL that goes in the email.
 *
 * **`APP_URL`, never `VERCEL_URL`** (`CLAUDE.md`) — the latter is the
 * per-deployment hostname and dies within days, which for a verification link
 * means a registrant clicking a dead URL and never getting tickets. Read
 * directly rather than through the validated env for the same reason
 * `queue.ts` does: queueing a message should not require the Supabase keys.
 */
export function verificationUrl(token: string): string {
  return `${process.env.APP_URL ?? ''}/f/verify?t=${encodeURIComponent(token)}`;
}

/**
 * Render and store the `public_verify` message as `DRAFT`.
 *
 * **`DRAFT`, not `QUEUED`** — decision 23, and §8.4's "created but **not**
 * sent". Only a human moves a row out of `DRAFT` (§11.2). Decision 38 narrowed
 * that rule for the feedback email alone, and narrowing it again here would be a
 * spec change rather than an implementation detail, so it is not made on this
 * branch. The consequence is real and belongs in the handoff: a verification
 * email waits for an admin to confirm the batch, so the gap between submitting
 * and being able to verify is however long that takes.
 *
 * Written inside the caller's transaction so a registration can never exist
 * with no way to verify it: either both land or neither does.
 */
export async function queueVerificationEmail(
  tx: Executor,
  input: {
    registrationId: number;
    contactName: string;
    contactEmail: string;
    token: string;
    concertName: string;
    showName: string;
    /**
     * `DRAFT` on submit (decision 23, below). The Audience workspace's *Send
     * verification reminder* (spec/v3.md §23.2) queues it directly: that command
     * previews every recipient before it runs, which is the human review
     * decision 23 asks for, and a reminder that then waited for a second
     * confirmation elsewhere would not be a reminder.
     */
    status?: 'DRAFT' | 'QUEUED';
  },
): Promise<boolean> {
  // Seeded with the default wording if the install never had it (V3): a
  // verification link must not wait for someone to open the templates page.
  const template = await templateFor(tx, 'public_verify');
  /**
   * No template is not a reason to lose the registration.
   *
   * The party has its seats and the admin can send the link by hand; throwing
   * here would roll back a claim that already succeeded, which trades a missing
   * email for a lost seat. It is logged rather than swallowed silently.
   */
  if (!template) {
    console.error(
      `no "public_verify" email template: registration ${input.registrationId} has a verification token but no message was drafted`,
    );
    return false;
  }

  const context = escapeMergeValues({
    'registration.contact_name': input.contactName,
    'registration.contact_email': input.contactEmail,
    'concert.name': input.concertName,
    'show.name': input.showName,
    verify_url: verificationUrl(input.token),
  });

  const subject = renderTemplate(template.subject, context);
  const body = renderTemplate(template.body_md, context);

  /**
   * `on conflict do nothing` against the partial unique index on
   * `(registration_id, purpose)` where the row is still pending
   * (`email.md` §11.4). A double-submitted form must not draft two links.
   */
  const inserted = await tx.execute<{ id: string }>(sql`
    insert into email_outbox (
      registration_id, purpose, template_key, to_email, to_name, subject, body_md, context,
      status
    ) values (
      ${input.registrationId}::bigint, 'VERIFICATION', 'public_verify',
      ${input.contactEmail}, ${input.contactName},
      ${subject.text}, ${body.text},
      ${JSON.stringify(context)}::text::jsonb, ${input.status ?? 'DRAFT'}::outbox_status
    )
    on conflict do nothing
    returning id
  `);
  return inserted.length > 0;
}

export type VerifyOutcome =
  /** Verified just now. */
  | { state: 'VERIFIED'; contactName: string }
  /** Already verified — clicking the link twice is not an error. */
  | { state: 'ALREADY' ; contactName: string }
  /** No such token, a malformed one, or one whose registration is gone. */
  | { state: 'UNKNOWN' };

/** What a token may look like, checked before it reaches the database. */
const TOKEN = /^[A-Za-z0-9_-]{1,255}$/;

/**
 * Verify a registration from the link in its email.
 *
 * **Idempotent, and it reports the difference without punishing it.** People
 * click twice, forward the mail to themselves, and open it again a week later;
 * a second click landing on "invalid link" would read as the first one having
 * failed and send them to the organisers. `ALREADY` is a success state with a
 * different sentence.
 *
 * **The token is not consumed.** Clearing it on use would ungate the
 * registration by the rule in `queue.ts` — where a null token means "never
 * needed verification" — so a verified party and an imported one would become
 * indistinguishable, and the admin review screen could no longer tell who had
 * actually clicked. `email_verified_at` is the fact; the token stays as the
 * thing that fact was proved with.
 */
export async function verifyRegistration(token: string): Promise<VerifyOutcome> {
  if (!TOKEN.test(token)) return { state: 'UNKNOWN' };

  const rows = await getDb().execute<{ contact_name: string; was_verified: boolean }>(sql`
    with target as (
      select id, contact_name, email_verified_at is not null as was_verified
        from registrations
       where verification_token = ${token}
         and deleted_at is null
       limit 1
    ),
    stamped as (
      update registrations r
         set email_verified_at = now()
        from target t
       where r.id = t.id
         -- Only the first click writes. A repeat must not move the timestamp,
         -- which is evidence of when the address was actually proved.
         and r.email_verified_at is null
      returning r.id
    )
    select t.contact_name, t.was_verified from target t
  `);

  const row = rows[0];
  if (!row) return { state: 'UNKNOWN' };
  return row.was_verified
    ? { state: 'ALREADY', contactName: row.contact_name }
    : { state: 'VERIFIED', contactName: row.contact_name };
}
