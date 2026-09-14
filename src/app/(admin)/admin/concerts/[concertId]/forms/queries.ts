import 'server-only';
import { and, asc, count, desc, eq, ilike, isNull, or, sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { resolveWithOrigin, type ResolvedSetting } from '@/db/cascade-origin';
import { concerts } from '@/db/schema/concerts';
import { formResponses, registrationForms } from '@/db/schema/registrations';
import { shows, showSegments } from '@/db/schema/shows';
import { parseFormSchema, type FormKind } from '@/lib/forms/schema';

/**
 * Everything the forms screens read (spec/admin.md §14.1, spec/domain.md §5.1).
 *
 * **A form has exactly one parent and `kind` decides which.** `PLAYER` and
 * `PUBLIC` hang off a segment, whose `audience_mode` they must agree with;
 * `FEEDBACK` hangs off a show and creates no seats at all (spec/v2.md §13.5).
 * The database settles the first half — `registration_forms_one_parent` — and
 * its own comment hands the `audience_mode` half to this module, because that
 * check needs the segment row. `actions.ts` is where it lives.
 *
 * Both parents are therefore left joins, and every query reaches the concert
 * through `coalesce(segment.show_id, form.show_id)`. An inner join would have
 * returned "no such form" for every feedback form, which is the bug `K` found
 * in its own loader the day `J` made `segment_id` nullable.
 */

export type FormStatus = 'DRAFT' | 'OPEN' | 'CLOSED';

/** The show a form ultimately belongs to, whichever parent it hangs off. */
const formShowId = sql<number>`coalesce(${showSegments.showId}, ${registrationForms.showId})::int`;

export type FormListRow = {
  id: number;
  kind: FormKind;
  title: string;
  slug: string;
  roundLabel: string | null;
  status: FormStatus;
  schemaVersion: number;
  /** Null on a form nobody has opened the builder on yet. */
  hasSchema: boolean;
  opensAt: Date | null;
  closesAt: Date | null;
  /** The segment, for a registration form; null for feedback. */
  segmentId: number | null;
  segmentName: string | null;
  audienceMode: 'PLAYER_INVITED' | 'PUBLIC' | null;
  showId: number;
  showName: string;
  responses: number;
};

export async function getConcertHeader(concertId: number) {
  const [row] = await getDb()
    .select({ id: concerts.id, name: concerts.name, timezone: concerts.timezone })
    .from(concerts)
    .where(and(eq(concerts.id, concertId), isNull(concerts.deletedAt)))
    .limit(1);
  return row ?? null;
}

/**
 * Every form on one concert, newest first within a show.
 *
 * The response count is a correlated subquery rather than a join and a group
 * by: the list is small, and counting in a join would need a `group by` over
 * every selected column for the sake of one number.
 */
export async function getFormsForConcert(concertId: number): Promise<FormListRow[]> {
  /**
   * How many responses this form has taken.
   *
   * Interpolated safely **because this select carries joins**: Drizzle
   * qualifies every column when it does, so the outer `registration_forms.id`
   * renders fully and the correlation binds where it should. It does *not* do
   * that for a single-table select — see the `supersededBy` subquery in
   * {@link getResponses}, which had to be written out for that reason.
   */
  const responseCount = sql<number>`(
    select count(*)::int from ${formResponses}
    where ${formResponses.formId} = ${registrationForms.id}
  )`;

  const rows = await getDb()
    .select({
      id: registrationForms.id,
      kind: registrationForms.kind,
      title: registrationForms.title,
      slug: registrationForms.slug,
      roundLabel: registrationForms.roundLabel,
      status: registrationForms.status,
      schemaVersion: registrationForms.schemaVersion,
      schema: registrationForms.schema,
      opensAt: registrationForms.opensAt,
      closesAt: registrationForms.closesAt,
      segmentId: registrationForms.segmentId,
      segmentName: showSegments.name,
      audienceMode: showSegments.audienceMode,
      showId: formShowId,
      showName: shows.name,
      responses: responseCount,
    })
    .from(registrationForms)
    .leftJoin(showSegments, eq(showSegments.id, registrationForms.segmentId))
    .innerJoin(shows, eq(shows.id, formShowId))
    .where(and(eq(shows.concertId, concertId), isNull(shows.deletedAt)))
    .orderBy(asc(shows.startsAt), asc(shows.id), desc(registrationForms.id));

  return rows.map((row) => ({
    ...row,
    kind: row.kind as FormKind,
    status: row.status as FormStatus,
    hasSchema: row.schema !== null,
    audienceMode: row.audienceMode as FormListRow['audienceMode'],
  }));
}

export type FormDetail = FormListRow & {
  descriptionMd: string | null;
  confirmationMessageMd: string | null;
  maxResponses: number | null;
  oneResponsePerIdentity: boolean | null;
  autoCloseOnCapacity: boolean | null;
  allowEditUntil: Date | null;
  /**
   * The raw column, which nothing reads (see `party-cap.ts`). Carried so the
   * editor can say so where a value was left behind by an earlier session,
   * rather than leaving it invisible and inert.
   */
  maxTicketsPerResponse: number | null;
  schema: unknown;
  concertId: number;
  timeZone: string | null;
};

export async function getForm(concertId: number, formId: number): Promise<FormDetail | null> {
  const responseCount = sql<number>`(
    select count(*)::int from ${formResponses}
    where ${formResponses.formId} = ${registrationForms.id}
  )`;

  const [row] = await getDb()
    .select({
      id: registrationForms.id,
      kind: registrationForms.kind,
      title: registrationForms.title,
      slug: registrationForms.slug,
      roundLabel: registrationForms.roundLabel,
      status: registrationForms.status,
      schemaVersion: registrationForms.schemaVersion,
      schema: registrationForms.schema,
      descriptionMd: registrationForms.descriptionMd,
      confirmationMessageMd: registrationForms.confirmationMessageMd,
      opensAt: registrationForms.opensAt,
      closesAt: registrationForms.closesAt,
      maxResponses: registrationForms.maxResponses,
      oneResponsePerIdentity: registrationForms.oneResponsePerIdentity,
      autoCloseOnCapacity: registrationForms.autoCloseOnCapacity,
      allowEditUntil: registrationForms.allowEditUntil,
      maxTicketsPerResponse: registrationForms.maxTicketsPerResponse,
      segmentId: registrationForms.segmentId,
      segmentName: showSegments.name,
      audienceMode: showSegments.audienceMode,
      showId: formShowId,
      showName: shows.name,
      responses: responseCount,
      concertId: shows.concertId,
      timeZone: concerts.timezone,
    })
    .from(registrationForms)
    .leftJoin(showSegments, eq(showSegments.id, registrationForms.segmentId))
    .innerJoin(shows, eq(shows.id, formShowId))
    .innerJoin(concerts, eq(concerts.id, shows.concertId))
    .where(
      and(
        eq(registrationForms.id, formId),
        eq(shows.concertId, concertId),
        isNull(shows.deletedAt),
      ),
    )
    .limit(1);

  if (!row) return null;

  return {
    ...row,
    kind: row.kind as FormKind,
    status: row.status as FormStatus,
    hasSchema: row.schema !== null,
    audienceMode: row.audienceMode as FormDetail['audienceMode'],
  };
}

/**
 * The parents a new form may attach to.
 *
 * Segments carry their `audience_mode` because the create dialog has to pair it
 * with `kind` — a `PLAYER` form on a public segment has no players to entitle,
 * and a `PUBLIC` form on a player segment would take a stranger's party into an
 * audience reserved for performers' guests. The dialog filters on it and
 * `actions.ts` refuses it again on the way in.
 */
export async function getFormParents(concertId: number) {
  const rows = await getDb()
    .select({
      showId: shows.id,
      showName: shows.name,
      startsAt: shows.startsAt,
      segmentId: showSegments.id,
      segmentName: showSegments.name,
      audienceMode: showSegments.audienceMode,
    })
    .from(shows)
    .leftJoin(showSegments, eq(showSegments.showId, shows.id))
    .where(and(eq(shows.concertId, concertId), isNull(shows.deletedAt)))
    .orderBy(asc(shows.startsAt), asc(shows.id), asc(showSegments.displayOrder));

  const showsById = new Map<
    number,
    {
      id: number;
      name: string;
      segments: { id: number; name: string; audienceMode: 'PLAYER_INVITED' | 'PUBLIC' }[];
    }
  >();

  for (const row of rows) {
    const show = showsById.get(row.showId) ?? {
      id: row.showId,
      name: row.showName,
      segments: [],
    };
    if (row.segmentId !== null) {
      show.segments.push({
        id: row.segmentId,
        name: row.segmentName ?? `Segment ${row.segmentId}`,
        audienceMode: row.audienceMode as 'PLAYER_INVITED' | 'PUBLIC',
      });
    }
    showsById.set(row.showId, show);
  }

  return [...showsById.values()];
}

/**
 * The caps and quotas a form's copy and repeaters will actually resolve to.
 *
 * Read **with their origin** and rendered read-only. The editor never offers
 * these as inputs: they are segment values (spec/domain.md §6) and §2.2 forbids
 * reading a raw column for one, so the screen that edits a form is the wrong
 * screen to set them from — it would write a fifth level the cascade does not
 * have. See `party-cap.ts`.
 */
export const FORM_CASCADE_KEYS = [
  'form.max_tickets_per_response',
  'form.extra_rows_max',
  'allocation.base_quota',
  'allocation.base_claim_deadline',
] as const;

export async function getFormCascade(
  form: Pick<FormDetail, 'segmentId' | 'showId' | 'concertId'>,
): Promise<Record<string, ResolvedSetting>> {
  return resolveWithOrigin([...FORM_CASCADE_KEYS], {
    segmentId: form.segmentId,
    showId: form.showId,
    concertId: form.concertId,
  });
}

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

export type ResponseRow = {
  id: number;
  submittedAt: Date;
  identityKey: string | null;
  /** The contact name and email lifted out of `raw`, for a readable list. */
  contactName: string | null;
  contactEmail: string | null;
  seats: number;
  /** Set when this row replaced an earlier one (spec/v2.md §8.3.1). */
  supersedesId: number | null;
  /** Set when a later row replaced this one — the head of a chain has none. */
  supersededById: number | null;
  ipAddress: string | null;
};

export type ResponsePage = {
  rows: ResponseRow[];
  rowCount: number;
};

const RESPONSE_SORTS = {
  submittedAt: formResponses.submittedAt,
  identityKey: formResponses.identityKey,
  id: formResponses.id,
} as const;

export type ResponseSortKey = keyof typeof RESPONSE_SORTS;

export function isResponseSortKey(value: string): value is ResponseSortKey {
  return value in RESPONSE_SORTS;
}

/**
 * One page of responses, paged, sorted and searched **in Postgres**
 * (`modules.md` §5.2.1).
 *
 * Server mode is not optional here: a response list that filtered in the
 * browser would search only the rows on screen, and this table is the one an
 * admin reaches for when somebody says "I registered and got nothing".
 *
 * The search reads `raw` rather than a projected column, because a response's
 * contact details live in its payload and nowhere else until seats are claimed.
 */
export async function getResponses(
  formId: number,
  options: { pageIndex: number; pageSize: number; sort: ResponseSortKey; desc: boolean; search: string },
): Promise<ResponsePage> {
  const db = getDb();

  /**
   * `%` and `_` are `LIKE` wildcards, so an unescaped term means something
   * other than what was typed — a search for `%` matches every response and
   * reads as "no filter applied" rather than "nothing found".
   *
   * The same escape module `H` applies to the scan log
   * (`src/lib/checkin/dashboard.ts`), for the same reason. The term is
   * parameterised either way, so this is about the search meaning what it
   * says, not about injection.
   */
  const search = options.search.trim();
  const escaped = search.replace(/([\\%_])/g, '\\$1');

  /**
   * The response that replaced this one, if any (spec/v2.md §8.3.1).
   *
   * **Written out rather than interpolated, and it has to be.** This select has
   * no joins, and for a single-table select Drizzle renders a column
   * *unqualified* — so `${formResponses.id}` became a bare `"id"`, which the
   * subquery resolved against its own `later` alias. The test read
   * `later.supersedes_id = later.id`, false for every row, and the "superseded"
   * badge never appeared for anybody. Nothing errored; the column was simply
   * always null.
   */
  const supersededBy = sql<number | null>`(
    select later.id from form_responses later
    where later.supersedes_id = form_responses.id
    limit 1
  )`;

  /**
   * The search reads the whole payload as text, not a projected column.
   *
   * A response's contact details live inside `raw`, under the id of whichever
   * block holds them — `registrant` for a form built from the template, but a
   * block id is the admin's and a feedback form has no registrant block at all.
   * Pinning the search to a path would therefore find nothing on exactly the
   * forms someone is most likely to be searching. Matching the payload's text
   * searches every answer, which is what "find this person's response" means.
   */
  const where = search
    ? and(
        eq(formResponses.formId, formId),
        or(
          ilike(sql`${formResponses.raw}::text`, `%${escaped}%`),
          ilike(sql`coalesce(${formResponses.identityKey}::text, '')`, `%${escaped}%`),
        ),
      )
    : eq(formResponses.formId, formId);

  const order = options.desc ? desc(RESPONSE_SORTS[options.sort]) : asc(RESPONSE_SORTS[options.sort]);

  const [rows, [totals]] = await Promise.all([
    db
      .select({
        id: formResponses.id,
        submittedAt: formResponses.submittedAt,
        identityKey: formResponses.identityKey,
        supersedesId: formResponses.supersedesId,
        supersededById: supersededBy,
        ipAddress: formResponses.ipAddress,
        raw: formResponses.raw,
        formSchema: formResponses.formSchema,
      })
      .from(formResponses)
      .where(where)
      .orderBy(order, desc(formResponses.id))
      .limit(options.pageSize)
      .offset(options.pageIndex * options.pageSize),
    db.select({ value: count() }).from(formResponses).where(where),
  ]);

  return {
    rows: rows.map((row) => ({
      id: row.id,
      submittedAt: row.submittedAt,
      identityKey: row.identityKey,
      ...contactFrom(row.formSchema, row.raw),
      seats: countSeats(row.formSchema, row.raw),
      supersedesId: row.supersedesId,
      supersededById: row.supersededById,
      ipAddress: row.ipAddress,
    })),
    rowCount: totals?.value ?? 0,
  };
}

/**
 * One block's answers, as `answers.ts` writes them into `raw`.
 *
 * Restated rather than imported so this file's readers can see the shape the
 * two functions below walk: a flat block holds one map of values, a repeater
 * holds a list of rows.
 */
type BlockPayload =
  | { kind: 'flat'; values: Record<string, unknown> }
  | { kind: 'repeater'; rows: Record<string, unknown>[] };

function payloadOf(raw: unknown): Record<string, BlockPayload | undefined> {
  return raw !== null && typeof raw === 'object'
    ? (raw as Record<string, BlockPayload | undefined>)
    : {};
}

/**
 * The registrant's name and email, read through the **pinned** schema.
 *
 * Not through a fixed `raw.registrant.contact_name` path: a block id belongs to
 * the form that was built, and reading a guessed one would show a blank column
 * on any form whose registrant block was named anything else. The pinned schema
 * is the only thing that knows where this response put its answers, which is
 * the same rule the exporter follows (spec/v2.md §8.5).
 *
 * Both are null for a feedback form, which has no registrant block at all.
 */
function contactFrom(
  formSchema: unknown,
  raw: unknown,
): { contactName: string | null; contactEmail: string | null } {
  const parsed = parseFormSchema(formSchema);
  if (!parsed.ok) return { contactName: null, contactEmail: null };

  const registrant = parsed.schema.blocks.find((block) => block.type === 'REGISTRANT');
  if (!registrant) return { contactName: null, contactEmail: null };

  const block = payloadOf(raw)[registrant.id];
  if (block?.kind !== 'flat') return { contactName: null, contactEmail: null };

  const read = (key: string) => {
    const value = block.values[key];
    return typeof value === 'string' && value.trim() !== '' ? value : null;
  };
  return { contactName: read('contact_name'), contactEmail: read('contact_email') };
}

/**
 * How many seats a submitted payload asked for.
 *
 * Counted from the payload's own repeater rows rather than from attendees,
 * because a response exists before — and independently of — the seats it
 * produced: `claim_seats()` may have granted fewer (spec/v2.md §8.3). This
 * column is what the registrant asked for, and the registrations screen is
 * where what they got is read.
 *
 * **The public registrant is seat #1** (decision 36), so a `creates_seat`
 * registrant block counts as one on top of the repeater rows. Leaving it out
 * would under-report every public party by exactly one, which is the arithmetic
 * that decision exists to keep consistent everywhere it appears.
 */
function countSeats(formSchema: unknown, raw: unknown): number {
  const payload = payloadOf(raw);
  let seats = 0;

  for (const block of Object.values(payload)) {
    if (block?.kind === 'repeater') seats += block.rows.length;
  }

  const parsed = parseFormSchema(formSchema);
  if (parsed.ok) {
    const registrant = parsed.schema.blocks.find((block) => block.type === 'REGISTRANT');
    if (registrant && 'creates_seat' in registrant && registrant.creates_seat) seats += 1;
  }

  return seats;
}

/**
 * Every response on a form, with its pinned schema, for the exporter.
 *
 * Unpaged on purpose: an export of "the rows on screen" is the one thing
 * nobody reconciling a spreadsheet wants. The cap is the export route's own
 * cell limit, which refuses a file too large rather than truncating one.
 */
export async function getResponsesForExport(formId: number) {
  return getDb()
    .select({
      id: formResponses.id,
      raw: formResponses.raw,
      formSchema: formResponses.formSchema,
      identityKey: formResponses.identityKey,
      submittedAt: formResponses.submittedAt,
      supersedesId: formResponses.supersedesId,
    })
    .from(formResponses)
    .where(eq(formResponses.formId, formId))
    .orderBy(asc(formResponses.submittedAt), asc(formResponses.id));
}
