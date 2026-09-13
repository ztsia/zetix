import 'server-only';
import { eq } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { concerts } from '@/db/schema/concerts';
import { registrationForms } from '@/db/schema/registrations';
import { shows, showSegments } from '@/db/schema/shows';
import { interpolateCopy, type CopyValues } from './copy';
import { resolveRepeaterLimits } from './limits';
import { resolveFormCopy } from './resolve-copy';
import { parseFormSchema, type FormSchema } from './schema';

/**
 * Loading a form by slug, and assembling everything the renderer needs
 * (spec/v2.md §8.2, §8.3).
 *
 * **This is the one place the three questions are answered together** — is this
 * form open, is its segment configured, and what does its copy resolve to — so
 * `L`'s preview, `M`'s public page and `M`'s edit screen cannot answer them
 * three different ways. Everything it returns is either renderable or a reason
 * it is not.
 *
 * What it deliberately does **not** decide: how many seats are left, whether
 * this person has already responded, and whether `max_responses` has been
 * reached. Those are `M`'s, and two of the three need allocation, which this
 * branch may not touch. The states here are the ones readable from the form row
 * and the cascade alone.
 */

export type FormNotAvailable =
  /**
   * No such form, a `DRAFT` one, or one whose schema no longer parses — **one
   * response for all three**, following the ticket page's rule (spec/v2.md §13.2).
   * A slug is a guessable thing; telling a prober that a draft form exists at
   * this address is telling them the address is worth watching.
   */
  | { state: 'NOT_FOUND' }
  /** `CLOSED`, or outside the `opens_at`/`closes_at` window (§8.3). */
  | { state: 'CLOSED'; title: string; opensAt: Date | null; closesAt: Date | null }
  /**
   * The form is fine; its segment is not configured, so a repeater cap resolves
   * to nothing.
   *
   * Refusing here is the same refusal `segment_pool()` makes: rendering a
   * repeater with an invented cap is the one failure that could take more seats
   * than exist (`CLAUDE.md`, spec/README.md §2.1). `missing` names the keys, for
   * the admin-facing message; the public one says only that the form is not
   * open yet.
   */
  | { state: 'NOT_CONFIGURED'; title: string; missing: string[] };

export type LoadedForm = {
  state: 'OPEN';
  id: number;
  slug: string;
  /** From the JSON, not from a column — the contract is what says what a form is. */
  kind: FormSchema['kind'];
  schema: FormSchema;
  /** The form's own heading, and its lead copy with `{{tokens}}` already resolved. */
  title: string;
  description: string | null;
  /** Row caps per repeater block id, ready for the renderer. */
  limits: Readonly<Record<string, number>>;
  /** The resolved token values, so a consumer can interpolate its own copy the same way. */
  copy: CopyValues;
  /** Where this form sits, for a caller that needs to resolve anything further. */
  segmentId: number;
  showId: number;
  concertId: number;
  timeZone: string | null;
  /** Editing window (§8.3.1). Read by `M`; carried here so one query answers everything. */
  allowEditUntil: Date | null;
};

export type FormLoadResult = LoadedForm | FormNotAvailable;

export type LoadFormOptions = {
  /** Base seats this registrant already holds — see `limits.ts`. */
  baseAlreadyClaimed?: number;
  /** `now`, injectable so a window test does not depend on the wall clock. */
  now?: Date;
};

export async function loadFormBySlug(
  slug: string,
  options: LoadFormOptions = {},
): Promise<FormLoadResult> {
  const now = options.now ?? new Date();

  const [row] = await getDb()
    .select({
      id: registrationForms.id,
      slug: registrationForms.slug,
      title: registrationForms.title,
      descriptionMd: registrationForms.descriptionMd,
      schema: registrationForms.schema,
      status: registrationForms.status,
      opensAt: registrationForms.opensAt,
      closesAt: registrationForms.closesAt,
      allowEditUntil: registrationForms.allowEditUntil,
      segmentId: showSegments.id,
      showId: shows.id,
      concertId: concerts.id,
      timeZone: concerts.timezone,
    })
    .from(registrationForms)
    .innerJoin(showSegments, eq(showSegments.id, registrationForms.segmentId))
    .innerJoin(shows, eq(shows.id, showSegments.showId))
    .innerJoin(concerts, eq(concerts.id, shows.concertId))
    .where(eq(registrationForms.slug, slug))
    .limit(1);

  if (!row) return { state: 'NOT_FOUND' };
  // A draft is not a form that exists yet, as far as anyone outside admin is
  // concerned.
  if (row.status === 'DRAFT') return { state: 'NOT_FOUND' };

  const parsed = parseFormSchema(row.schema);
  if (!parsed.ok) {
    /**
     * A saved schema that no longer parses.
     *
     * It reads as "no such form" to the caller and is logged for whoever has to
     * fix it. Rendering it half-drawn is the one option that is definitely
     * wrong: the contract is what guarantees the email question is the email
     * question (decision 35), and a form drawn around a failed parse has no such
     * guarantee.
     */
    console.error(`registration_forms.schema for "${slug}" does not parse:\n${parsed.message}`);
    return { state: 'NOT_FOUND' };
  }

  const closed =
    row.status === 'CLOSED' ||
    (row.opensAt !== null && now < row.opensAt) ||
    (row.closesAt !== null && now >= row.closesAt);

  if (closed) {
    return { state: 'CLOSED', title: row.title, opensAt: row.opensAt, closesAt: row.closesAt };
  }

  const ctx = { segmentId: row.segmentId, showId: row.showId, concertId: row.concertId };
  const [copy, limits] = await Promise.all([
    resolveFormCopy({ ...ctx, timeZone: row.timeZone }),
    resolveRepeaterLimits(parsed.schema, {
      ...ctx,
      baseAlreadyClaimed: options.baseAlreadyClaimed,
    }),
  ]);

  if (!limits.ok) return { state: 'NOT_CONFIGURED', title: row.title, missing: limits.missing };

  return {
    state: 'OPEN',
    id: row.id,
    slug: row.slug,
    kind: parsed.schema.kind,
    schema: parsed.schema,
    title: row.title,
    description: row.descriptionMd ? interpolateCopy(row.descriptionMd, copy).text : null,
    limits: limits.limits,
    copy,
    segmentId: row.segmentId,
    showId: row.showId,
    concertId: row.concertId,
    timeZone: row.timeZone,
    allowEditUntil: row.allowEditUntil,
  };
}
