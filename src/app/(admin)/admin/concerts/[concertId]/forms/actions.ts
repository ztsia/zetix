'use server';

import { revalidatePath } from 'next/cache';
import { TZDate } from '@date-fns/tz';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '@/db/client';
import { dbErrorMessage, pgError } from '@/db/errors';
import { concerts } from '@/db/schema/concerts';
import { formResponses, registrationForms } from '@/db/schema/registrations';
import { shows, showSegments } from '@/db/schema/shows';
import { writeAuditLog } from '@/lib/audit';
import { requireAdmin } from '@/lib/auth/guards';
import { FORM_KINDS, parseFormSchema, type FormKind } from '@/lib/forms/schema';
import { blankFormSchema } from '@/lib/forms/templates';
import { slugify } from '../../form-state';
import type { FormState } from '../../form-state';

/**
 * Creating, editing and opening forms (spec/v2.md §8.2, spec/admin.md §14.1).
 *
 * Four rules shape every action here.
 *
 * **`kind` and the schema are written together, from one value.** They govern
 * different halves of one fact — the column decides the parent, the JSON
 * decides the blocks — and `K`'s loader refuses a form where they disagree,
 * because a form whose seats have nowhere to go is not something to render
 * half of. Nothing in this file writes one without the other.
 *
 * **The `audience_mode` half of "exactly one parent" is ours.**
 * `registration_forms_one_parent` settles what Postgres can settle cheaply —
 * feedback hangs off a show, registration forms off a segment — and its own
 * comment hands this module the half that needs the segment row: a `PLAYER`
 * form belongs to a `PLAYER_INVITED` segment and a `PUBLIC` form to a `PUBLIC`
 * one. A mismatch here is seats allocated under the wrong audience's rules.
 *
 * **Saving the schema bumps `schema_version`** (§8.2.4). Responses pin the
 * version they were answered against, so an edit must never reach back and
 * change what an answer already given meant — the same pattern, for the same
 * reason, as pinning a ticket's template version.
 *
 * **No operational value is written from code.** Not one number on these forms
 * has a default here; the caps and quotas a form's copy resolves are segment
 * values read through the cascade, and this screen shows them rather than
 * setting them (`party-cap.ts`, CLAUDE.md).
 */

const UNIQUE_VIOLATION = '23505';

/**
 * A clash on `registration_forms_slug_key`, said in words.
 *
 * The link is unique across **every** concert, so the form it collides with may
 * not be one the admin can see from here — which is exactly why the raw
 * Postgres sentence is no use to them. Modules `A` and `B` map this code for
 * the same reason.
 */
function formErrorMessage(error: unknown, slug: string): string {
  if (pgError(error)?.code === UNIQUE_VIOLATION) {
    return `The link "${slug}" is already taken by another form. Links are unique across every concert, so try something more specific.`;
  }
  return dbErrorMessage(error);
}

const blankToNull = (value: unknown) => {
  const trimmed = typeof value === 'string' ? value.trim() : value;
  return trimmed === '' || trimmed === undefined ? null : trimmed;
};

const optionalCount = z.preprocess(
  blankToNull,
  z.coerce.number().int().min(1, 'A limit of zero would close the form; use Close instead.').nullable(),
);

const optionalText = z.preprocess(blankToNull, z.string().trim().max(500).nullable());
const optionalLongText = z.preprocess(blankToNull, z.string().trim().max(5000).nullable());

const localDateTime = z.preprocess(
  blankToNull,
  z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/, 'Use the date and time picker.')
    .nullable(),
);

const checkbox = z.preprocess((value) => value === 'on' || value === 'true', z.boolean());

/**
 * A wall-clock time in the concert's zone, as the instant it names.
 *
 * A form's window is read against the venue's clock — "closes at midnight on
 * the 12th" means midnight there — so a form cannot take a window before its
 * concert has a zone (spec/domain.md §6.1). The same conversion module `A`
 * uses for show times, for the same reason.
 */
function toInstant(local: string | null, timeZone: string): Date | null {
  if (!local) return null;
  const [datePart, timePart] = local.split('T');
  const [year, month, day] = datePart.split('-').map(Number);
  const [hour, minute] = timePart.split(':').map(Number);
  const zoned = TZDate.tz(timeZone, year, month - 1, day, hour, minute);
  return new Date(zoned.getTime());
}

/** The concert a form must belong to, and the zone its window is read in. */
async function loadConcert(concertId: number) {
  const [row] = await getDb()
    .select({ id: concerts.id, timezone: concerts.timezone })
    .from(concerts)
    .where(and(eq(concerts.id, concertId), isNull(concerts.deletedAt)))
    .limit(1);
  return row ?? null;
}

/**
 * The form, re-read inside the action with its concert proved.
 *
 * Every action takes `concertId` from the URL and the form id from the form,
 * and neither is trustworthy on its own: a form id from another concert would
 * otherwise be editable by anyone who could guess it. Joining back to the
 * concert is the authorization check, not a convenience.
 */
async function loadForm(concertId: number, formId: number) {
  // Server Actions take their arguments from the client, so an id that is not an
  // integer is refused here rather than handed to Postgres as a `NaN` parameter.
  if (!Number.isSafeInteger(concertId) || !Number.isSafeInteger(formId)) return null;
  const showId = sql<number>`coalesce(${showSegments.showId}, ${registrationForms.showId})`;
  const [row] = await getDb()
    .select({
      id: registrationForms.id,
      kind: registrationForms.kind,
      status: registrationForms.status,
      schemaVersion: registrationForms.schemaVersion,
      slug: registrationForms.slug,
      title: registrationForms.title,
      segmentId: registrationForms.segmentId,
      showId,
    })
    .from(registrationForms)
    .leftJoin(showSegments, eq(showSegments.id, registrationForms.segmentId))
    .innerJoin(shows, eq(shows.id, showId))
    .where(
      and(
        eq(registrationForms.id, formId),
        eq(shows.concertId, concertId),
        isNull(shows.deletedAt),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Whether a segment may carry a form of this kind.
 *
 * The check the database's own comment defers to this module. `PLAYER` and
 * `PLAYER_INVITED` are two spellings of one audience, and `PUBLIC` is one word
 * doing duty as both a form kind and an audience mode, which is exactly why
 * this is worth writing down rather than trusting to a dropdown.
 */
function audienceFor(kind: FormKind): 'PLAYER_INVITED' | 'PUBLIC' | null {
  if (kind === 'PLAYER') return 'PLAYER_INVITED';
  if (kind === 'PUBLIC') return 'PUBLIC';
  return null;
}

const createSchema = z.object({
  kind: z.enum(FORM_KINDS),
  parentId: z.coerce.number().int().positive('Choose where this form belongs.'),
  title: z.string().trim().min(1, 'A form needs a title.').max(300),
  roundLabel: optionalText,
  slug: optionalText,
});

/**
 * A new form: the row and its starting schema, in one statement.
 *
 * The schema is `blankFormSchema(kind)` and never hand-assembled — `K`'s
 * templates are the only safe way to build one, because a builder that composed
 * system blocks itself would eventually compose one the contract refuses, and
 * the admin would meet that refusal on an otherwise blank screen.
 */
export async function createFormAction(
  concertId: number,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  await requireAdmin();

  const parsed = createSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Check the form.' };
  }
  const { kind, parentId, title, roundLabel } = parsed.data;

  const concert = await loadConcert(concertId);
  if (!concert) return { error: 'That concert no longer exists.' };

  const db = getDb();
  const audience = audienceFor(kind);

  let segmentId: number | null = null;
  let showId: number | null = null;

  if (audience === null) {
    // FEEDBACK attaches to a show and creates no seats (spec/v2.md §13.5).
    const [show] = await db
      .select({ id: shows.id })
      .from(shows)
      .where(
        and(eq(shows.id, parentId), eq(shows.concertId, concertId), isNull(shows.deletedAt)),
      )
      .limit(1);
    if (!show) return { error: 'That show is not part of this concert.' };
    showId = show.id;
  } else {
    const [segment] = await db
      .select({ id: showSegments.id, audienceMode: showSegments.audienceMode })
      .from(showSegments)
      .innerJoin(shows, eq(shows.id, showSegments.showId))
      .where(
        and(
          eq(showSegments.id, parentId),
          eq(shows.concertId, concertId),
          isNull(shows.deletedAt),
        ),
      )
      .limit(1);
    if (!segment) return { error: 'That segment is not part of this concert.' };

    if (segment.audienceMode !== audience) {
      return {
        error:
          kind === 'PLAYER'
            ? 'A player form entitles players to their base seats, and this segment has no players — its audience is public. Put it on a player-invited segment, or create a public form.'
            : 'A public form takes a stranger’s party, and this segment is reserved for players and their guests. Put it on a public segment, or create a player form.',
      };
    }
    segmentId = segment.id;
  }

  const slug = parsed.data.slug ? slugify(parsed.data.slug) : slugify(title);
  if (!slug) {
    return { error: 'That title produces an empty link. Add a slug, or use letters in the title.' };
  }

  try {
    const [created] = await db
      .insert(registrationForms)
      .values({
        kind,
        segmentId,
        showId,
        title,
        roundLabel,
        slug,
        // Written from the same value as `kind`, in the same statement: `K`'s
        // loader refuses a form whose column and JSON disagree.
        schema: blankFormSchema(kind),
        schemaVersion: 1,
        status: 'DRAFT',
      })
      .returning({ id: registrationForms.id });

    await writeAuditLog({
      action: 'form.create',
      entityType: 'registration_form',
      entityId: String(created.id),
      after: { kind, title, slug, segmentId, showId },
    });

    revalidatePath(`/admin/concerts/${concertId}/forms`);
    return { error: null, message: String(created.id) };
  } catch (error) {
    return { error: formErrorMessage(error, slug) };
  }
}

/**
 * Save the block schema, and bump the version (§8.2.4).
 *
 * The parse is the boundary decisions 35 and 37 stand on, so it happens here
 * on the server and not only in the builder: a schema posted by anything else —
 * a replayed request, a future script — meets the same contract. A failure
 * returns the contract's own message, which names the JSON path, because an
 * admin who cannot see *which* field is wrong will work around the boundary
 * instead of fixing the schema.
 */
export async function saveFormSchemaAction(
  concertId: number,
  formId: number,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  await requireAdmin();

  const form = await loadForm(concertId, formId);
  if (!form) return { error: 'That form no longer exists.' };

  const raw = formData.get('schema');
  if (typeof raw !== 'string') return { error: 'The builder sent nothing to save.' };

  let candidate: unknown;
  try {
    candidate = JSON.parse(raw);
  } catch {
    return { error: 'The builder sent something that is not valid JSON.' };
  }

  const parsed = parseFormSchema(candidate);
  if (!parsed.ok) return { error: parsed.message };

  /**
   * The schema's `kind` is the form's, not the payload's.
   *
   * Taking it from the request would let a save turn a player form into a
   * public one while leaving it attached to a player segment — the exact
   * disagreement `K`'s loader refuses to render, arrived at through the front
   * door.
   */
  if (parsed.schema.kind !== form.kind) {
    return { error: `This is a ${form.kind} form and its schema says ${parsed.schema.kind}.` };
  }

  try {
    const [updated] = await getDb()
      .update(registrationForms)
      .set({
        schema: parsed.schema,
        // Read-modify-write in one statement: two admins saving at once both
        // get a version, and neither silently takes the other's.
        schemaVersion: sql`${registrationForms.schemaVersion} + 1`,
      })
      .where(eq(registrationForms.id, formId))
      .returning({ version: registrationForms.schemaVersion });

    await writeAuditLog({
      action: 'form.schema.save',
      entityType: 'registration_form',
      entityId: String(formId),
      after: { schemaVersion: updated.version, title: form.title },
    });

    revalidatePath(`/admin/concerts/${concertId}/forms/${formId}`, 'layout');
    return { error: null, message: `Saved as version ${updated.version}.` };
  } catch (error) {
    return { error: dbErrorMessage(error) };
  }
}

/**
 * Everything the Settings tab owns. **Not the title or the introduction** —
 * those are the header card's (`saveFormHeaderAction`), and a settings save that
 * also wrote them would carry whatever they were when the Settings tab was
 * opened, silently undoing a newer header edit saved from another tab.
 */
const settingsSchema = z.object({
  roundLabel: optionalText,
  slug: z.string().trim().min(1, 'A form needs a link.').max(120),
  confirmationMessageMd: optionalLongText,
  opensAt: localDateTime,
  closesAt: localDateTime,
  allowEditUntil: localDateTime,
  maxResponses: optionalCount,
  oneResponsePerIdentity: checkbox,
  autoCloseOnCapacity: checkbox,
});

/** The form's own settings — its window, its limits and its confirmation copy (§8.3). */
export async function saveFormSettingsAction(
  concertId: number,
  formId: number,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  await requireAdmin();

  const form = await loadForm(concertId, formId);
  if (!form) return { error: 'That form no longer exists.' };

  const concert = await loadConcert(concertId);
  if (!concert) return { error: 'That concert no longer exists.' };

  const parsed = settingsSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Check the form.' };
  }
  const values = parsed.data;

  const wantsWindow = values.opensAt || values.closesAt || values.allowEditUntil;
  if (wantsWindow && !concert.timezone) {
    return {
      error:
        'This concert has no timezone, so a form window would be stored against a guess. Set one on the concert first.',
    };
  }

  const zone = concert.timezone ?? 'UTC';
  const opensAt = toInstant(values.opensAt, zone);
  const closesAt = toInstant(values.closesAt, zone);
  const allowEditUntil = toInstant(values.allowEditUntil, zone);

  if (opensAt && closesAt && closesAt <= opensAt) {
    return { error: 'The form would close before it opened.' };
  }

  const slug = slugify(values.slug);
  if (!slug) return { error: 'That link is empty once tidied. Use letters, digits and dashes.' };

  try {
    await getDb()
      .update(registrationForms)
      .set({
        roundLabel: values.roundLabel,
        slug,
        confirmationMessageMd: values.confirmationMessageMd,
        opensAt,
        closesAt,
        allowEditUntil,
        maxResponses: values.maxResponses,
        oneResponsePerIdentity: values.oneResponsePerIdentity,
        autoCloseOnCapacity: values.autoCloseOnCapacity,
      })
      .where(eq(registrationForms.id, formId));

    await writeAuditLog({
      action: 'form.settings.save',
      entityType: 'registration_form',
      entityId: String(formId),
      after: { title: form.title, slug, opensAt, closesAt, maxResponses: values.maxResponses },
    });

    revalidatePath(`/admin/concerts/${concertId}/forms/${formId}`, 'layout');
    return { error: null, message: 'Settings saved.' };
  } catch (error) {
    return { error: formErrorMessage(error, slug) };
  }
}

const headerSchema = z.object({
  title: z.string().trim().min(1, 'A form needs a title.').max(300),
  descriptionMd: optionalLongText,
});

/**
 * The title and introduction, from the header card at the top of the builder.
 *
 * **Its own action rather than a partial settings save.** Google Forms edits
 * these in place, above the questions, and the builder does the same — but
 * `saveFormSettingsAction` writes every setting at once, and a header edit that
 * went through it would have to resend the window, the limits and the link it
 * never showed, and could overwrite a change made in the Settings tab since.
 * Two columns, written by the one screen that edits them.
 */
export async function saveFormHeaderAction(
  concertId: number,
  formId: number,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  await requireAdmin();

  const form = await loadForm(concertId, formId);
  if (!form) return { error: 'That form no longer exists.' };

  const parsed = headerSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Check the title.' };
  }

  try {
    await getDb()
      .update(registrationForms)
      .set({ title: parsed.data.title, descriptionMd: parsed.data.descriptionMd })
      .where(eq(registrationForms.id, formId));

    await writeAuditLog({
      action: 'form.header.save',
      entityType: 'registration_form',
      entityId: String(formId),
      before: { title: form.title },
      after: { title: parsed.data.title },
    });

    revalidatePath(`/admin/concerts/${concertId}/forms/${formId}`, 'layout');
    return { error: null, message: 'Saved.' };
  } catch (error) {
    return { error: dbErrorMessage(error) };
  }
}

const statusSchema = z.object({ status: z.enum(['DRAFT', 'OPEN', 'CLOSED']) });

/**
 * `DRAFT` → `OPEN` → `CLOSED`, and the one transition that is refused.
 *
 * A form that has taken responses never goes back to `DRAFT`. `DRAFT` is the
 * state where the builder is free and nothing depends on the schema; returning
 * to it with responses already pinned to a version invites an edit whose
 * meaning silently diverges from the answers underneath it. Closing and opening
 * a new round is the path the spec gives instead (`domain.md` §5.1).
 */
export async function setFormStatusAction(
  concertId: number,
  formId: number,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  await requireAdmin();

  const form = await loadForm(concertId, formId);
  if (!form) return { error: 'That form no longer exists.' };

  const parsed = statusSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: 'Unknown status.' };
  const { status } = parsed.data;

  if (status === 'OPEN') {
    const [row] = await getDb()
      .select({ schema: registrationForms.schema })
      .from(registrationForms)
      .where(eq(registrationForms.id, formId))
      .limit(1);
    const check = parseFormSchema(row?.schema);
    if (!check.ok) {
      return { error: `This form cannot open until its schema is valid.\n\n${check.message}` };
    }
  }

  if (status === 'DRAFT') {
    const [{ responses }] = await getDb()
      .select({ responses: sql<number>`count(*)::int` })
      .from(formResponses)
      .where(eq(formResponses.formId, formId));
    if (responses > 0) {
      return {
        error: `This form has ${responses} response${responses === 1 ? '' : 's'} pinned to its schema, so it cannot return to draft. Close it and open a new round instead.`,
      };
    }
  }

  try {
    await getDb()
      .update(registrationForms)
      .set({ status })
      .where(eq(registrationForms.id, formId));

    await writeAuditLog({
      action: 'form.status',
      entityType: 'registration_form',
      entityId: String(formId),
      before: { status: form.status },
      after: { status },
    });

    revalidatePath(`/admin/concerts/${concertId}/forms`);
    revalidatePath(`/admin/concerts/${concertId}/forms/${formId}`, 'layout');
    return { error: null, message: `Form is now ${status.toLowerCase()}.` };
  } catch (error) {
    return { error: dbErrorMessage(error) };
  }
}

const newRoundSchema = z.object({
  roundLabel: z.string().trim().min(1, 'Name the round, so the two are told apart.').max(500),
  slug: optionalText,
  closeCurrent: checkbox,
});

/**
 * A second round: a **new form on the same segment**, never an edit of the old
 * one (`domain.md` §5.1).
 *
 * This exists as its own button because the alternative is what an admin will
 * otherwise do — reopen round 1 and edit it — and that rewrites the meaning of
 * every answer round 1 already took. Copying the schema forward keeps the
 * questions; a new row keeps the answers.
 */
export async function startNewRoundAction(
  concertId: number,
  formId: number,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  await requireAdmin();

  const source = await loadForm(concertId, formId);
  if (!source) return { error: 'That form no longer exists.' };

  const parsed = newRoundSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Check the form.' };
  }
  const { roundLabel, closeCurrent } = parsed.data;

  const db = getDb();
  const [full] = await db
    .select({
      kind: registrationForms.kind,
      title: registrationForms.title,
      descriptionMd: registrationForms.descriptionMd,
      confirmationMessageMd: registrationForms.confirmationMessageMd,
      schema: registrationForms.schema,
      segmentId: registrationForms.segmentId,
      showId: registrationForms.showId,
      maxResponses: registrationForms.maxResponses,
      oneResponsePerIdentity: registrationForms.oneResponsePerIdentity,
      autoCloseOnCapacity: registrationForms.autoCloseOnCapacity,
    })
    .from(registrationForms)
    .where(eq(registrationForms.id, formId))
    .limit(1);
  if (!full) return { error: 'That form no longer exists.' };

  const slug = slugify(parsed.data.slug ?? `${full.title} ${roundLabel}`);
  if (!slug) return { error: 'That round produces an empty link. Give it a slug.' };

  try {
    const created = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(registrationForms)
        .values({
          kind: full.kind,
          segmentId: full.segmentId,
          showId: full.showId,
          title: full.title,
          roundLabel,
          slug,
          descriptionMd: full.descriptionMd,
          confirmationMessageMd: full.confirmationMessageMd,
          // The questions carry over; the window and the answers do not. A new
          // round that inherited round 1's dates would open in the past.
          schema: full.schema,
          schemaVersion: 1,
          maxResponses: full.maxResponses,
          oneResponsePerIdentity: full.oneResponsePerIdentity,
          autoCloseOnCapacity: full.autoCloseOnCapacity,
          status: 'DRAFT',
        })
        .returning({ id: registrationForms.id });

      if (closeCurrent) {
        await tx
          .update(registrationForms)
          .set({ status: 'CLOSED' })
          .where(eq(registrationForms.id, formId));
      }

      return row;
    });

    await writeAuditLog({
      action: 'form.new_round',
      entityType: 'registration_form',
      entityId: String(created.id),
      after: { roundLabel, slug, copiedFrom: formId, closedSource: closeCurrent },
    });

    revalidatePath(`/admin/concerts/${concertId}/forms`);
    return { error: null, message: String(created.id) };
  } catch (error) {
    return { error: formErrorMessage(error, slug) };
  }
}
