'use server';

import { headers } from 'next/headers';
import { sql } from 'drizzle-orm';
import { claimSeats, lockShowForClaim, type SeatRequest } from '@/db/allocation';
import { getDb } from '@/db/client';
import { clientIp, consumeRateLimit, formBucket } from '@/lib/auth/rate-limit';
import { adviseOnAddress } from '@/lib/email/address';
import { validateAnswers, type AnswerErrors, type FormAnswers } from '@/lib/forms/answers';
import { loadFormBySlug } from '@/lib/forms/load';
import { resolveRegistrant } from '@/lib/forms/registrant';
import { mintVerificationToken, queueVerificationEmail } from '@/lib/registrations/verification';
import { blockFields, isRepeaterType, type FormField, type FormSchema } from '@/lib/forms/schema';

/**
 * Submitting `/f/{slug}` (spec/v2.md §8.1–§8.4).
 *
 * **Seats come from `claim_seats()` and from nowhere else.** That function is
 * the correctness core and oversell must be impossible (`CLAUDE.md`,
 * `allocation.md` §7.3, §7.8), so everything this action computes about caps and
 * seat counts is a *prediction* it then hands to the engine. Where the engine
 * disagrees the engine is right, and the confirmation screen says what actually
 * happened — it never silently succeeds with fewer seats than the form showed
 * (§8.3).
 *
 * **Nothing here is trusted from the page.** A Server Action is its own
 * request: the window may have closed, the pool may have emptied, the player
 * may have claimed seats in another tab and an admin may have saved a new
 * schema since the form was drawn. All of it is re-read.
 */

export type SubmitInput = {
  slug: string;
  token: string | null;
  /** What the browser drew. Compared against the live one — see below. */
  schemaVersion: number;
  answers: FormAnswers;
  /** The reader has seen an address warning and submitted anyway. */
  addressConfirmed: boolean;
};

export type SubmitResult =
  | { ok: true; confirmationUrl: string }
  | {
      ok: false;
      message?: string;
      /** Keyed exactly as `validateAnswers` keys them, for the renderer. */
      errors?: AnswerErrors;
      /** Tells the client to accept the address if it is submitted again. */
      addressWarning?: boolean;
    };

/** The system field keys (`lib/forms/system-fields.ts`). */
const CONTACT_NAME = 'contact_name';
const CONTACT_EMAIL = 'contact_email';
const CONTACT_PHONE = 'contact_phone';
const GUEST_NAME = 'full_name';
const GUEST_EMAIL = 'email';

/** Form-level settings `loadFormBySlug` does not carry, read by this action alone. */
type FormSettings = {
  maxResponses: number | null;
  oneResponsePerIdentity: boolean;
  autoCloseOnCapacity: boolean;
  responseCount: number;
};

async function formSettingsFor(formId: number): Promise<FormSettings> {
  const rows = await getDb().execute<{
    max_responses: number | null;
    one_response_per_identity: boolean | null;
    auto_close_on_capacity: boolean | null;
    response_count: number;
  }>(sql`
    select
      f.max_responses,
      f.one_response_per_identity,
      f.auto_close_on_capacity,
      -- Superseded responses are edits of a party that already counted, not new
      -- parties (§8.3.1). Counting them would close a form early by however many
      -- people corrected a typo.
      (select count(*)::int
         from form_responses fr
        where fr.form_id = f.id
          and not exists (
            select 1 from form_responses later where later.supersedes_id = fr.id
          )) as response_count
    from registration_forms f
    where f.id = ${formId}::bigint
  `);
  const row = rows[0];
  return {
    maxResponses: row?.max_responses ?? null,
    oneResponsePerIdentity: row?.one_response_per_identity ?? false,
    autoCloseOnCapacity: row?.auto_close_on_capacity ?? false,
    responseCount: Number(row?.response_count ?? 0),
  };
}

function flatValues(answers: FormAnswers, blockId: string): Record<string, unknown> {
  const block = answers[blockId];
  return block?.kind === 'flat' ? block.values : {};
}

function rowsOf(answers: FormAnswers, blockId: string): Record<string, unknown>[] {
  const block = answers[blockId];
  return block?.kind === 'repeater' ? block.rows : [];
}

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * The custom answers only, for `registrations.custom` and `attendees.custom`
 * (§8.2.3).
 *
 * The queryable copy exists because `raw` is written only for `source = FORM`;
 * an admin table or an export reading `raw` would show blanks for every
 * imported and admin-created registration, which are most of them.
 */
function customOnly(
  fields: readonly FormField[],
  values: Record<string, unknown>,
): Record<string, unknown> | null {
  const custom: Record<string, unknown> = {};
  for (const field of fields) {
    if (field.system) continue;
    if (field.key in values) custom[field.key] = values[field.key];
  }
  return Object.keys(custom).length > 0 ? custom : null;
}

/**
 * `registrations.custom` — every custom answer in the **flat scope**, not just
 * the REGISTRANT block's.
 *
 * A form's custom questions usually live in their own `CUSTOM` block ("Before
 * you go…"), which is exactly where the interesting answers are. Gathering only
 * the REGISTRANT block's would drop them from the queryable copy while leaving
 * them in `raw` — so the export and every admin filter would show blanks for
 * questions people actually answered, and nothing would report it.
 *
 * Keys are unique across the flat scope by contract (`schema.ts`), so merging
 * the blocks cannot collide.
 */
function registrationCustom(
  schema: FormSchema,
  answers: FormAnswers,
): Record<string, unknown> | null {
  const merged: Record<string, unknown> = {};
  for (const block of schema.blocks) {
    if (isRepeaterType(block.type)) continue;
    const found = customOnly(blockFields(block), flatValues(answers, block.id));
    if (found) Object.assign(merged, found);
  }
  return Object.keys(merged).length > 0 ? merged : null;
}

/**
 * Drop repeater rows that carry nothing at all, before validation sees them.
 *
 * **A public registrant with no guests could not submit without this.**
 * `emptyAnswers` seeds every repeater with one row when it has room for one —
 * deliberately, because a repeater showing only an "add" button reads as an
 * empty section — and that row's `full_name` is required. So the default state
 * of a public form is one blank guest, and validation refuses it with "This is
 * required" against a person the reader never said was coming.
 *
 * **This is not the truncation `K` warns about, and the line between them is
 * the whole point.** A row with *any* content and a missing required field is
 * an error and stays one: that is somebody half-typed, and silently dropping
 * them is how a party of four arrives with three tickets. A row with *nothing*
 * in it was never a person — it is the seeded row, or the add button pressed
 * once too often — and there is nothing to lose by removing it.
 *
 * An unticked checkbox counts as nothing: a box the reader never touched is not
 * evidence that a guest exists.
 */
function pruneBlankRows(schema: FormSchema, answers: FormAnswers): FormAnswers {
  const pruned: FormAnswers = { ...answers };
  for (const block of schema.blocks) {
    if (!isRepeaterType(block.type)) continue;
    const current = answers[block.id];
    if (current?.kind !== 'repeater') continue;
    pruned[block.id] = {
      kind: 'repeater',
      rows: current.rows.filter((row) =>
        Object.values(row).some((value) => {
          if (value === null || value === undefined || value === false) return false;
          if (Array.isArray(value)) return value.length > 0;
          if (typeof value === 'string') return value.trim() !== '';
          return true;
        }),
      ),
    };
  }
  return pruned;
}

/**
 * The party, in the order the seats should be created.
 *
 * **On a public form the registrant is seat #1** (decision 36): the REGISTRANT
 * block produces the registration's contact fields *and* the first attendee, so
 * a cap of 4 renders three guest rows and this turns them into four seats.
 * `creates_seat` on the block carries that, and it is the one structural
 * difference between the two form kinds.
 *
 * **All public seats are `EXTRA`** (§8.1.2). A `PUBLIC` segment has no players,
 * so `unclaimed_base = 0` and `extras_pool = open_seats`; import already coerces
 * a mapped `BASE` to `EXTRA` there, and the native form lands in the same place.
 * No new allocation type is introduced.
 */
function partyFor(
  schema: FormSchema,
  answers: FormAnswers,
): { seats: SeatRequest[]; seatCustom: (Record<string, unknown> | null)[] } {
  const seats: SeatRequest[] = [];
  const seatCustom: (Record<string, unknown> | null)[] = [];

  for (const block of schema.blocks) {
    if (block.type === 'REGISTRANT') {
      if (!('creates_seat' in block) || !block.creates_seat) continue;
      const values = flatValues(answers, block.id);
      seats.push({
        fullName: text(values[CONTACT_NAME]),
        email: text(values[CONTACT_EMAIL]),
        allocationType: 'EXTRA',
      });
      seatCustom.push(customOnly(blockFields(block), values));
      continue;
    }

    if (!isRepeaterType(block.type)) continue;

    const allocationType = block.type === 'GUESTS_BASE' ? 'BASE' : 'EXTRA';
    for (const row of rowsOf(answers, block.id)) {
      /**
       * A row the person added and left entirely blank is not a seat — it is
       * the "add" button pressed once too often. `validateAnswers` has already
       * refused a row that carries anything but is missing its required name,
       * so nothing with content is dropped here.
       */
      const name = text(row[GUEST_NAME]);
      const email = text(row[GUEST_EMAIL]);
      if (name === null && email === null) continue;
      seats.push({ fullName: name, email, allocationType });
      seatCustom.push(customOnly(blockFields(block), row));
    }
  }

  return { seats, seatCustom };
}

export async function submitRegistration(input: SubmitInput): Promise<SubmitResult> {
  const requestHeaders = await headers();

  /** Throttled again: a Server Action is its own request, not the page's. */
  const verdict = await consumeRateLimit(formBucket(clientIp(requestHeaders)));
  if (!verdict.allowed) {
    return {
      ok: false,
      message: `Too many requests. Please wait ${verdict.retryAfterSeconds} seconds and try again.`,
    };
  }

  const now = new Date();
  const form = await loadFormBySlug(input.slug, { now });

  if (form.state === 'NOT_FOUND') return { ok: false, message: 'This form is not available.' };
  if (form.state === 'CLOSED') {
    return { ok: false, message: 'Registration has closed. Nothing was submitted.' };
  }
  if (form.state === 'NOT_CONFIGURED') {
    return { ok: false, message: 'This form is not open yet. Nothing was submitted.' };
  }
  const segmentId = form.segmentId;
  if (segmentId === null) {
    return { ok: false, message: 'This form does not take registrations.' };
  }

  /**
   * The schema moved under the reader.
   *
   * Validating a payload against a schema they never saw would report errors on
   * questions that were not on their screen, and pin a schema whose meaning does
   * not match their answers (§8.2.4). Refusing and asking for a reload is the
   * only honest option, and it is rare — `L` bumps the version on every save.
   */
  if (form.schemaVersion !== input.schemaVersion) {
    return {
      ok: false,
      message:
        'This form was updated while you were filling it in. Please reload the page and submit again — nothing was saved.',
    };
  }

  const registrant = await resolveRegistrant(input.token, form.concertId, segmentId);

  /**
   * Row caps recomputed for **this** registrant rather than taken from the page.
   *
   * A player who opened the form with three base seats left, claimed two in
   * another tab and came back would otherwise submit against the stale cap.
   */
  const live =
    registrant.kind === 'PLAYER' && registrant.baseAlreadyClaimed > 0
      ? await loadFormBySlug(input.slug, { now, baseAlreadyClaimed: registrant.baseAlreadyClaimed })
      : form;
  const limits = live.state === 'OPEN' ? live.limits : form.limits;

  /**
   * **Over the row cap is an error, not a truncation** (`K`'s contract).
   * Silently dropping the fourth member of a party of four is the failure the
   * form builder exists to prevent.
   */
  const answers = pruneBlankRows(form.schema, input.answers);
  const validation = validateAnswers(form.schema, answers, { limits });
  if (!validation.ok) {
    return {
      ok: false,
      errors: validation.errors,
      message: 'Please check the highlighted answers and submit again.',
    };
  }

  const registrantBlock = form.schema.blocks.find((block) => block.type === 'REGISTRANT');
  if (!registrantBlock) return { ok: false, message: 'This form cannot take registrations.' };

  const contact = flatValues(answers, registrantBlock.id);
  const contactEmail = text(contact[CONTACT_EMAIL]);
  const contactName = text(contact[CONTACT_NAME]);

  /** Every response carries an email and a name; the contract requires it (§8.1.3). */
  if (contactEmail === null || contactName === null) {
    return { ok: false, message: 'Please give your name and email address.' };
  }

  /**
   * The address checks (`lib/email/address.ts`), on the first attempt only.
   *
   * A domain DNS is certain does not exist cannot receive the tickets this
   * registration is for, and the person is right here able to fix it — an hour
   * later only an admin can, and only if they notice. But a resolver can be
   * wrong and a scarce seat is too much to lose to one DNS answer, so the first
   * submit is refused with the reason and the second is accepted. Nobody is
   * locked out; nobody types `.con` without being told.
   */
  if (!input.addressConfirmed) {
    const advice = await adviseOnAddress(contactEmail);
    if (advice.blocking) {
      return {
        ok: false,
        message: `${advice.blocking} Submit again to use it anyway.`,
        errors: { [`${registrantBlock.id}.${CONTACT_EMAIL}`]: 'Check this address' },
        addressWarning: true,
      };
    }
  }

  const settings = await formSettingsFor(form.id);

  if (settings.maxResponses !== null && settings.responseCount >= settings.maxResponses) {
    return { ok: false, message: 'This form has reached its limit of responses.' };
  }

  /**
   * `identity_key` — the player id, or the lowercased email (§8.3).
   *
   * Null unless the form asks for the limit: writing it always would make the
   * partial index refuse a second response on every form. **The uniqueness is
   * the database's**, never a read-then-write check here — a query would be a
   * race at exactly the moment scarce seats attract double-clicks, the same
   * reasoning that makes `claim_seats()` a Postgres function. The column is
   * `citext`, so the lowercasing is the type's job rather than this handler's.
   */
  const identityKey = settings.oneResponsePerIdentity
    ? registrant.kind === 'PLAYER'
      ? `player:${registrant.playerId}`
      : contactEmail
    : null;

  const { seats, seatCustom } = partyFor(form.schema, answers);
  if (seats.length === 0) return { ok: false, message: 'Please add at least one seat.' };

  /**
   * **Only a public form's registrant is asked to verify** (§8.1.4).
   *
   * A player's address came from the roster rather than from a stranger typing
   * it, and an imported registrant never received a link at all — so neither is
   * issued a token, and `queue.ts` reads the absence of one as "nothing to wait
   * for". Deciding it here, by form kind, is what keeps that rule in one place:
   * nothing in the schema distinguishes a player form from an import, and
   * nothing should (`J`'s handoff).
   */
  const verificationToken = form.kind === 'PUBLIC' ? mintVerificationToken() : null;

  const editToken = crypto.randomUUID().replaceAll('-', '');
  const userAgent = requestHeaders.get('user-agent');
  const ip = clientIp(requestHeaders);
  const registrantCustom = registrationCustom(form.schema, answers);

  try {
    const confirmationUrl = await getDb().transaction(async (tx) => {
      /**
       * **The hall lock first, before anything references the show.** Without
       * it two concurrent submits deadlock: the registration insert's foreign
       * key takes a shared lock on the `shows` row and `claim_seats()` then asks
       * to upgrade it. See `lockShowForClaim()`.
       */
      await lockShowForClaim(form.showId, tx);

      /**
       * The receipt first, because the registration points at it
       * (`registrations.form_response_id`, §8.3.1 — *"the registration points at
       * the newest response"*), and that link is what the confirmation screen
       * and the edit flow both resolve through.
       *
       * Going in this order also means `one_response_per_identity` fires before
       * any seat is touched. The transaction would roll back either way; failing
       * on the cheap statement is simply the better shape.
       *
       * `raw` is exactly what was submitted and is never mutated; `form_schema`
       * pins what those answers meant (§8.2.3, §8.2.4).
       */
      const response = await tx.execute<{ id: string }>(sql`
        insert into form_responses (
          form_id, raw, form_schema, identity_key, submitted_at,
          ip_address, user_agent, edit_token
        ) values (
          ${form.id}::bigint,
          -- raw is what they submitted, not what we pruned: §8.2.3 calls it the
          -- receipt of what the person actually typed, so a blank row we chose
          -- to ignore is still part of that record.
          ${JSON.stringify(input.answers)}::text::jsonb,
          ${JSON.stringify(form.schema)}::text::jsonb,
          ${identityKey},
          ${now.toISOString()}::timestamptz,
          ${ip}, ${userAgent}, ${editToken}
        )
        returning id
      `);
      const responseId = Number(response[0].id);

      const inserted = await tx.execute<{ id: string }>(sql`
        insert into registrations (
          show_id, segment_id, round_label, player_id, source, form_response_id,
          contact_name, contact_email, contact_phone, status, requested_at, custom,
          verification_token
        ) values (
          ${form.showId}::bigint, ${segmentId}::bigint, ${form.copy.round_label ?? null},
          ${registrant.kind === 'PLAYER' ? registrant.playerId : null}::bigint, 'FORM',
          ${responseId}::bigint,
          ${contactName}, ${contactEmail}, ${text(contact[CONTACT_PHONE])},
          -- Corrected from the seats a moment later in this same transaction.
          -- claim_seats() refuses a CANCELLED registration, so it has to be one
          -- of the other three, and WAITLIST is the one that is wrong in the
          -- safe direction: a party holding nothing rather than a party recorded
          -- as confirmed with no seats.
          'WAITLIST',
          ${now.toISOString()}::timestamptz,
          ${registrantCustom === null ? null : JSON.stringify(registrantCustom)}::text::jsonb,
          ${verificationToken}
        )
        returning id
      `);
      const registrationId = Number(inserted[0].id);

      /**
       * **The row lock is the truth.** Everything above was a prediction; this
       * is the decision. Partial grants, `PENDING_REVIEW` and `WAITLIST` all
       * come back in the outcome, and the confirmation screen reports them
       * (§8.3, §8.4).
       */
      await claimSeats(segmentId, registrationId, seats, { executor: tx });

      /**
       * A registration reflects its party — the same rule module `C` applies at
       * import: confirmed if any seat is, otherwise pending, otherwise
       * waitlisted.
       */
      await tx.execute(sql`
        update registrations r
           set status = case
                 when exists (select 1 from attendees a
                               where a.registration_id = r.id and a.status = 'CONFIRMED'
                                 and a.deleted_at is null) then 'CONFIRMED'
                 when exists (select 1 from attendees a
                               where a.registration_id = r.id and a.status = 'PENDING_REVIEW'
                                 and a.deleted_at is null) then 'PENDING_REVIEW'
                 else 'WAITLIST'
               end::booking_status
         where r.id = ${registrationId}::bigint
      `);

      /**
       * Per-seat custom answers, matched to the attendees the engine just
       * created. `claim_seats()` inserts in the order it was given, so the
       * party's order is the seat order and `id` preserves it.
       */
      const withCustom = seatCustom
        .map((custom, index) => ({ custom, index }))
        .filter((entry) => entry.custom !== null);
      if (withCustom.length > 0) {
        const attendeeRows = await tx.execute<{ id: string }>(sql`
          select id from attendees
           where registration_id = ${registrationId}::bigint
             and deleted_at is null
           order by id
        `);
        for (const entry of withCustom) {
          const attendee = attendeeRows[entry.index];
          if (!attendee) continue;
          await tx.execute(sql`
            update attendees set custom = ${JSON.stringify(entry.custom)}::text::jsonb
             where id = ${Number(attendee.id)}::bigint
          `);
        }
      }

      /**
       * `auto_close_on_capacity` (§8.3), in the same transaction as the claim so
       * the form closes on the submit that filled it rather than on whatever
       * page load happens to come next.
       */
      if (settings.autoCloseOnCapacity) {
        await tx.execute(sql`
          update registration_forms
             set status = 'CLOSED'
           where id = ${form.id}::bigint
             and status = 'OPEN'
             and (segment_pool(${segmentId}::bigint)->>'extras_pool')::int <= 0
        `);
      }

      /**
       * The verification message, drafted in the same transaction as the
       * registration it belongs to. Either both land or neither does — a
       * registration carrying a token nobody was ever sent is a party that can
       * never be ticketed and has nothing on screen to say why.
       */
      if (verificationToken !== null) {
        const [context] = await tx.execute<{ concert_name: string; show_name: string }>(sql`
          select c.name as concert_name, s.name as show_name
            from shows s join concerts c on c.id = s.concert_id
           where s.id = ${form.showId}::bigint
        `);
        await queueVerificationEmail(tx, {
          registrationId,
          contactName,
          contactEmail,
          token: verificationToken,
          concertName: context?.concert_name ?? '',
          showName: context?.show_name ?? '',
        });
      }

      return `/f/${form.slug}/done?r=${editToken}`;
    });

    return { ok: true, confirmationUrl };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    /**
     * **The constraint name has to be dug out of the cause chain.**
     *
     * `postgres.js` reports it as `constraint_name` and `rethrowDbError`
     * re-exposes it as `constraint`, but Drizzle wraps the driver error in its
     * own "Failed query: …" error and the original only survives as `cause`. A
     * check against the top-level message alone therefore matches nothing, and
     * both of the named cases below silently became "something went wrong" —
     * which is how this was found.
     */
    const violated = (name: string): boolean => {
      let current: unknown = error;
      for (let depth = 0; current && depth < 5; depth++) {
        if (typeof current === 'object') {
          const record = current as {
            constraint?: unknown;
            constraint_name?: unknown;
            message?: unknown;
            cause?: unknown;
          };
          if (record.constraint === name || record.constraint_name === name) return true;
          if (typeof record.message === 'string' && record.message.includes(name)) return true;
          current = record.cause;
          continue;
        }
        break;
      }
      return message.includes(name);
    };

    /**
     * The identity index firing is not a crash — it is the form's own
     * `one_response_per_identity` rule arriving from the only place that can
     * enforce it without a race.
     */
    if (violated('form_responses_identity_key')) {
      return {
        ok: false,
        message:
          'You have already registered with this form. Use the link in your confirmation email to change your response.',
      };
    }

    /*
     * `registrations_no_duplicate_import` used to be mapped here. V3 dropped the
     * index (spec/v3.md §30.1): a second submission from the same address is
     * merged into the existing party (§25.5), which is module `V`'s intake.
     */

    console.error(`registration submit failed for "${input.slug}":`, error);
    return { ok: false, message: 'Something went wrong and nothing was saved. Please try again.' };
  }
}
