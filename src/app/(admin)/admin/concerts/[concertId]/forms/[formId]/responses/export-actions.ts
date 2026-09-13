'use server';

import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { concerts } from '@/db/schema/concerts';
import { feedbackResponses } from '@/db/schema/feedback';
import { attendees, registrationForms } from '@/db/schema/registrations';
import { shows, showSegments } from '@/db/schema/shows';
import { requireAdmin } from '@/lib/auth/guards';
import { buildExportTable, type ExportableResponse, type ExportTable } from '@/lib/forms/export';
import { formatInZone } from '@/lib/export';
import { getResponsesForExport } from '../../queries';

/**
 * The export for all three form kinds (spec/v2.md §8.5).
 *
 * **One row per registration for registration forms; one row per attendee for
 * feedback.** They read different tables — a feedback response is keyed by
 * attendee and lives in `feedback_responses`, deliberately not in
 * `form_responses` (`domain.md` §5.1) — but the answer half of the table is
 * built identically, from each response's own pinned schema. That is what lets
 * `L` own one exporter rather than two.
 *
 * A Server Action rather than a Route Handler: the caller is the admin's own
 * screen, and the rows are then posted to `/api/export/xlsx`, which `F2` built.
 * There is no second exporter and no per-module endpoint (`modules.md` §4).
 */

export type FormExport = ExportTable & { filename: string; sheetName: string; timeZone: string };

/** The form, its concert proved, exactly as the editor's actions do it. */
async function loadForm(concertId: number, formId: number) {
  const showId = sql<number>`coalesce(${showSegments.showId}, ${registrationForms.showId})`;
  const [row] = await getDb()
    .select({
      id: registrationForms.id,
      kind: registrationForms.kind,
      title: registrationForms.title,
      slug: registrationForms.slug,
      roundLabel: registrationForms.roundLabel,
      timeZone: concerts.timezone,
    })
    .from(registrationForms)
    .leftJoin(showSegments, eq(showSegments.id, registrationForms.segmentId))
    .innerJoin(shows, eq(shows.id, showId))
    .innerJoin(concerts, eq(concerts.id, shows.concertId))
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

export async function buildFormExportAction(
  concertId: number,
  formId: number,
): Promise<{ error: string; data: null } | { error: null; data: FormExport }> {
  await requireAdmin();

  const form = await loadForm(concertId, formId);
  if (!form) return { error: 'That form no longer exists.', data: null };

  // Timestamps render in the concert's zone, never the reader's (`CLAUDE.md`).
  // Without one there is no honest way to write a time, so the export says so
  // rather than silently using the server's.
  const timeZone = form.timeZone;
  if (!timeZone) {
    return {
      error:
        'This concert has no timezone, so submission times cannot be written. Set one on the concert first.',
      data: null,
    };
  }

  const table =
    form.kind === 'FEEDBACK'
      ? await feedbackTable(formId, timeZone)
      : await registrationTable(formId, timeZone);

  const base = [form.title, form.roundLabel].filter(Boolean).join(' ');

  return {
    error: null,
    data: {
      ...table,
      filename: base || form.slug,
      sheetName: form.kind === 'FEEDBACK' ? 'Feedback' : 'Responses',
      timeZone,
    },
  };
}

/**
 * One row per registration, with the party expanded into numbered seat columns.
 *
 * The edit chain is carried as two columns rather than by filtering superseded
 * rows out: §8.3.1 makes an edit a *new* row chained by `supersedes_id`, and an
 * export that silently dropped the earlier ones would lose the history an admin
 * reads when a registrant disputes what they submitted. Which row is current is
 * a column, so the reader can filter in the spreadsheet.
 */
async function registrationTable(formId: number, timeZone: string): Promise<ExportTable> {
  const rows = await getResponsesForExport(formId);
  const supersededIds = new Set(
    rows.map((row) => row.supersedesId).filter((id): id is number => id !== null),
  );

  const responses: ExportableResponse[] = rows.map((row) => ({
    id: row.id,
    formSchema: row.formSchema,
    payload: row.raw,
    submittedAt: row.submittedAt,
    meta: {
      'Response': row.id,
      'Submitted': formatInZone(row.submittedAt, timeZone),
      'Identity': row.identityKey,
      'Replaces': row.supersedesId,
      'Superseded': supersededIds.has(row.id),
    },
  }));

  return buildExportTable(responses, [
    { header: 'Response', key: 'Response' },
    { header: 'Submitted', key: 'Submitted', width: 20 },
    { header: 'Identity', key: 'Identity', width: 28 },
    { header: 'Replaces', key: 'Replaces' },
    { header: 'Superseded', key: 'Superseded' },
  ]);
}

/** One row per attendee (spec/v2.md §13.5) — the person, not the party, answered. */
async function feedbackTable(formId: number, timeZone: string): Promise<ExportTable> {
  const rows = await getDb()
    .select({
      id: feedbackResponses.id,
      answers: feedbackResponses.answers,
      formSchema: feedbackResponses.formSchema,
      submittedAt: feedbackResponses.submittedAt,
      attendeeId: feedbackResponses.attendeeId,
      attendeeName: attendees.fullName,
      showName: shows.name,
    })
    .from(feedbackResponses)
    .innerJoin(attendees, eq(attendees.id, feedbackResponses.attendeeId))
    .innerJoin(shows, eq(shows.id, feedbackResponses.showId))
    .where(eq(feedbackResponses.formId, formId))
    .orderBy(asc(feedbackResponses.submittedAt), asc(feedbackResponses.id));

  const responses: ExportableResponse[] = rows.map((row) => ({
    id: row.id,
    formSchema: row.formSchema,
    payload: row.answers,
    submittedAt: row.submittedAt,
    meta: {
      'Response': row.id,
      'Submitted': formatInZone(row.submittedAt, timeZone),
      'Attendee': row.attendeeName,
      'Show': row.showName,
    },
  }));

  return buildExportTable(responses, [
    { header: 'Response', key: 'Response' },
    { header: 'Submitted', key: 'Submitted', width: 20 },
    { header: 'Attendee', key: 'Attendee', width: 28 },
    { header: 'Show', key: 'Show', width: 24 },
  ]);
}
