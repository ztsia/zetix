import 'server-only';
import { eq, sql } from 'drizzle-orm';
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
   * No such form, a malformed slug, a `DRAFT` one, or one whose schema no longer
   * parses — **one response for all of them**, following the ticket page's rule
   * (spec/v2.md §13.2).
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
  /**
   * The column and the JSON agree, or the form does not load at all — see
   * below. Both are checked because they answer different questions: the column
   * decides which parent the form hangs off (`J`'s
   * `registration_forms_one_parent`), the JSON decides which blocks it may
   * carry.
   */
  kind: FormSchema['kind'];
  schema: FormSchema;
  /**
   * `registration_forms.schema_version`, so `M` can pin it onto the response it
   * writes (§8.2.4) and `L` can key its preview on it. Carried here because one
   * query should answer everything the surface needs.
   */
  schemaVersion: number;
  /** The form's own heading, and its lead copy with `{{tokens}}` already resolved. */
  title: string;
  description: string | null;
  /** Row caps per repeater block id, ready for the renderer. */
  limits: Readonly<Record<string, number>>;
  /** The resolved token values, so a consumer can interpolate its own copy the same way. */
  copy: CopyValues;
  /**
   * Where this form sits. **`segmentId` is null for a `FEEDBACK` form**, which
   * hangs off the show instead — every cascade read here already takes null and
   * simply starts one level up.
   */
  segmentId: number | null;
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

/**
 * What a slug may be, checked before it reaches the database.
 *
 * A path segment is untrusted input like any other, and this is the zod
 * boundary `CLAUDE.md`'s conventions ask for. Without it a `%00` in the URL
 * travels intact into a parameterised query and Postgres raises `22021`
 * ("unsupported Unicode escape sequence") — a `500` with an empty body, on a
 * public route, for something that is simply not a slug.
 *
 * The shape matches how slugs are actually minted: lowercase, digits and
 * hyphens. Anything else is **not found**, not "bad request" — telling a prober
 * that their guess was well-formed but absent is one bit more than telling them
 * nothing.
 */
const SLUG = /^[a-z0-9][a-z0-9-]{0,127}$/;

export async function loadFormBySlug(
  slug: string,
  options: LoadFormOptions = {},
): Promise<FormLoadResult> {
  if (!SLUG.test(slug)) return { state: 'NOT_FOUND' };

  const now = options.now ?? new Date();

  const [row] = await getDb()
    .select({
      id: registrationForms.id,
      slug: registrationForms.slug,
      kind: registrationForms.kind,
      schemaVersion: registrationForms.schemaVersion,
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
    /**
     * **Left, not inner.** A form has exactly one parent and `kind` says which
     * (`registration_forms_one_parent`): a `FEEDBACK` form hangs off the show
     * and has no segment at all. An inner join here would silently return "no
     * such form" for every feedback form in the system.
     */
    .leftJoin(showSegments, eq(showSegments.id, registrationForms.segmentId))
    /**
     * The show, reached through whichever parent exists. Still inner — a form
     * with neither parent cannot exist, and if one somehow did there would be no
     * concert to render its times in.
     */
    .innerJoin(
      shows,
      sql`${shows.id} = coalesce(${showSegments.showId}, ${registrationForms.showId})`,
    )
    .innerJoin(concerts, eq(concerts.id, shows.concertId))
    .where(eq(registrationForms.slug, slug))
    .limit(1);

  if (!row) return { state: 'NOT_FOUND' };
  // A draft is not a form that exists yet, as far as anyone outside admin is
  // concerned.
  if (row.status === 'DRAFT') return { state: 'NOT_FOUND' };

  const parsed = parseFormSchema(row.schema);
  if (parsed.ok && parsed.schema.kind !== row.kind) {
    /**
     * The column and the JSON disagree about what this form is.
     *
     * They govern different halves of the same fact — the column decides the
     * parent, the JSON decides the blocks — so a disagreement is a form whose
     * seats have nowhere to go: a `PUBLIC` schema hanging off a show, or a
     * `FEEDBACK` schema on a segment with a party repeater the check constraint
     * never saw. Neither can be rendered into anything correct, so it reads as
     * "no such form" like an unparseable schema, and is logged for whoever has
     * to fix it. Only `L` can write this row, and only by bypassing its own
     * builder.
     */
    console.error(
      `registration_forms "${slug}": kind column is ${row.kind} but its schema says ${parsed.schema.kind}`,
    );
    return { state: 'NOT_FOUND' };
  }
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
    schemaVersion: row.schemaVersion,
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
