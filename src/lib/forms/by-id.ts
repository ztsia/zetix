import 'server-only';

import { and, eq, isNull, sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { concerts } from '@/db/schema/concerts';
import { shows, showSegments } from '@/db/schema/shows';
import { registrationForms } from '@/db/schema/registrations';
import type { FormKind } from './schema';

/**
 * Load one form by its id alone, for the preview surface.
 *
 * **Why this is not `getForm`.** The admin console's loader takes a concert as
 * well as a form and scopes the query to it, because it is reached from a
 * concert's own pages and that pairing is what makes a wrong id a 404 rather
 * than a cross-concert read. The preview is reached from a link with no concert
 * in it, so it resolves the concert *from* the form instead — and returns it,
 * so the caller can send the reader back to the right builder.
 *
 * That is safe here and nowhere else: `requireRole` runs before this, and the
 * admin account is not scoped to a concert (`spec/checkin.md` §12.3 —
 * asymmetric auth: one shared admin, many show-scoped operators). An operator
 * must never reach this function.
 */

/** A form hangs off a segment or, when it is FEEDBACK, off a show (§13.5). */
const formShowId = sql<number>`coalesce(${showSegments.showId}, ${registrationForms.showId})::int`;

export type FormForPreview = {
  id: number;
  kind: FormKind;
  title: string;
  description: string | null;
  status: string;
  schema: unknown;
  segmentId: number | null;
  showId: number;
  concertId: number;
  timeZone: string | null;
};

export async function getFormById(formId: number): Promise<FormForPreview | null> {
  const [row] = await getDb()
    .select({
      id: registrationForms.id,
      kind: registrationForms.kind,
      title: registrationForms.title,
      description: registrationForms.descriptionMd,
      status: registrationForms.status,
      schema: registrationForms.schema,
      segmentId: registrationForms.segmentId,
      showId: formShowId,
      concertId: shows.concertId,
      timeZone: concerts.timezone,
    })
    .from(registrationForms)
    .leftJoin(showSegments, eq(showSegments.id, registrationForms.segmentId))
    .innerJoin(shows, eq(shows.id, formShowId))
    .innerJoin(concerts, eq(concerts.id, shows.concertId))
    .where(and(eq(registrationForms.id, formId), isNull(shows.deletedAt)))
    .limit(1);

  if (!row) return null;
  return { ...row, kind: row.kind as FormKind };
}
