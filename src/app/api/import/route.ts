import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getSessionUser } from '@/lib/auth/session';
import { writeAuditLog } from '@/lib/audit';
import { buildPlanContext, loadSegmentTarget } from '@/lib/import/context';
import { commitImport, recordDryRun } from '@/lib/import/commit';
import { planImport } from '@/lib/import/plan';
import {
  detectHeaderRow,
  distinctValues,
  ImportParseError,
  parseWorkbook,
  toSheetRows,
} from '@/lib/import/parse';
import { parseMappingProfile } from '@/lib/import/profile';
import { suggestColumns } from '@/lib/import/template';

/**
 * The spreadsheet import endpoint (spec/import.md §9.1, §9.6).
 *
 * Node runtime, because `exceljs` is a Node module (spec/platform.md §16.1).
 *
 * **The file is re-sent with every step rather than held on the server.** The
 * client keeps it and posts it for `inspect`, `dry-run` and `commit` alike. That
 * is not laziness: the planner is pure, so re-parsing and re-planning the same
 * bytes gives the same answer, and the alternative — parking the upload in
 * Storage or a session — introduces state that can expire, leak between admins,
 * or be committed after the segment it was planned against has changed. A file
 * of a few hundred rows is tens of kilobytes.
 *
 * **`ADMIN` only.** Import writes registrations for the whole segment; an
 * operator may not even export (spec/admin.md §14.3). `/api` is outside the
 * proxy matcher, so the check has to be here.
 */
export const runtime = 'nodejs';
export const maxDuration = 60;

const profileSchema = z.unknown();

const actionSchema = z.enum(['inspect', 'dry-run', 'commit']);

/**
 * Player choices made on the dry-run screen, as `{ "cell value": playerId }`
 * (spec/import.md §9.3).
 *
 * Sent with the dry run *and* the commit, because both re-plan from the file and
 * a commit that dropped them would silently reinstate every block the admin just
 * cleared. The ids are re-validated against this concert in
 * `loadPlayerOverrides` — this only checks the shape.
 */
const overridesSchema = z.record(z.string(), z.number().int().positive());

function readPlayerOverrides(raw: FormDataEntryValue | null): Map<string, number> {
  if (typeof raw !== 'string' || raw === '') return new Map();
  const parsed = overridesSchema.safeParse(JSON.parse(raw));
  return parsed.success ? new Map(Object.entries(parsed.data)) : new Map();
}

/** The typed confirmation the commit requires (§9.6, mirroring §7.5). */
const commitSchema = z.object({
  confirmation: z.string().min(1),
});

export async function POST(request: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  if (user.role !== 'ADMIN') return NextResponse.json({ error: 'Admins only' }, { status: 403 });

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: 'Expected a multipart upload.' }, { status: 400 });
  }

  const action = actionSchema.safeParse(form.get('action'));
  if (!action.success) {
    return NextResponse.json(
      { error: 'action must be one of inspect, dry-run, commit.' },
      { status: 400 },
    );
  }

  const segmentId = Number(form.get('segmentId'));
  if (!Number.isInteger(segmentId) || segmentId <= 0) {
    return NextResponse.json({ error: 'A target segment is required.' }, { status: 400 });
  }

  const file = form.get('file');
  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'No file was uploaded.' }, { status: 400 });
  }

  let target;
  try {
    target = await loadSegmentTarget(segmentId);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unknown segment.' },
      { status: 404 },
    );
  }

  let workbook;
  try {
    workbook = await parseWorkbook(await file.arrayBuffer(), file.name);
  } catch (error) {
    // A parse failure is the admin's file, not a server fault: 400 with the
    // message, so the screen can name the sheet rather than say "went wrong".
    if (error instanceof ImportParseError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }

  // `inspect` needs no profile: it is what the admin uses to build one.
  if (action.data === 'inspect') {
    const sheets = workbook.sheets.map((s) => ({
      name: s.name,
      rowCount: s.rows.length,
      detectedHeaderRow: detectHeaderRow(s.rows),
    }));
    const chosenName = (form.get('sheet') as string | null) ?? sheets[0]?.name;
    const sheet = workbook.sheets.find((s) => s.name === chosenName) ?? workbook.sheets[0];
    const headerRow = Number(form.get('headerRow')) || detectHeaderRow(sheet.rows);

    let headers: string[] = [];
    let sample: Record<string, string>[] = [];
    let rowCount = 0;
    try {
      const parsed = toSheetRows(sheet, headerRow);
      headers = parsed.headers;
      rowCount = parsed.rows.length;
      sample = parsed.rows.slice(0, 5).map((r) => r.cells);
    } catch (error) {
      if (error instanceof ImportParseError) {
        return NextResponse.json({ error: error.message }, { status: 400 });
      }
      throw error;
    }

    const allocationColumn = form.get('allocationColumn') as string | null;
    const { rows } = toSheetRows(sheet, headerRow);

    return NextResponse.json({
      audienceMode: target.audienceMode,
      sheets,
      sheet: sheet.name,
      headerRow,
      headers,
      rowCount,
      sample,
      // Preselected, never applied (§9.2): the screen shows every proposal.
      suggested: suggestColumns(headers),
      // The distinct values actually in the chosen column, so the allocation
      // mapping is built from the file rather than typed from memory (§9.6).
      allocationValues: allocationColumn ? distinctValues(rows, allocationColumn) : [],
      // Every header's distinct count, so the screen can warn before the admin
      // picks a column with 300 unique values as the allocation type.
      preview: headers.map((h) => ({ header: h, distinct: distinctValues(rows, h).length })),
    });
  }

  // Both remaining actions need a mapping profile.
  let profile;
  try {
    const raw = form.get('profile');
    if (typeof raw !== 'string') throw new Error('No mapping profile was sent.');
    profile = parseMappingProfile(profileSchema.parse(JSON.parse(raw)));
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? `Mapping profile is invalid: ${error.message}` : 'Bad profile.',
      },
      { status: 400 },
    );
  }

  const sheet =
    workbook.sheets.find((s) => s.name === (profile.sheet ?? '')) ?? workbook.sheets[0];

  let rows;
  try {
    rows = toSheetRows(sheet, profile.headerRow).rows;
  } catch (error) {
    if (error instanceof ImportParseError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }

  let playerOverrides: Map<string, number>;
  try {
    playerOverrides = readPlayerOverrides(form.get('playerOverrides'));
  } catch {
    return NextResponse.json({ error: 'Player choices could not be read.' }, { status: 400 });
  }

  const context = await buildPlanContext(target, profile, rows, playerOverrides);
  const plan = planImport(rows, profile, context);

  const payload = {
    audienceMode: target.audienceMode,
    counts: plan.counts,
    largestParty: plan.largestParty,
    findings: plan.findings,
    openSeats: context.openSeats,
    extrasPool: context.extrasPool,
    extrasPolicy: context.extrasPolicy,
    parties: plan.parties.map((p) => ({
      key: p.key,
      rows: p.rowNumbers,
      contactName: p.contactName,
      contactEmail: p.contactEmail,
      requestedAt: p.requestedAt.toISOString(),
      playerId: p.playerId,
      playerName: p.playerName,
      blocked: p.blocked,
      seats: p.seats.map((s) => ({
        rowNumber: s.rowNumber,
        fullName: s.fullName,
        email: s.email,
        allocationType: s.allocationType,
        promotedFromBase: s.promotedFromBase,
      })),
    })),
  };

  if (action.data === 'dry-run') {
    const batchId = await recordDryRun({
      target,
      filename: file.name,
      plan,
      uploadedBy: user.id,
    });
    return NextResponse.json({ ...payload, batchId, committed: false });
  }

  // Commit. The typed confirmation is checked server-side as well as in the
  // dialog: there is no rollback (decision 26), so the gate cannot live only in
  // a component that a stale tab could bypass.
  const confirmation = commitSchema.safeParse({ confirmation: form.get('confirmation') });
  if (!confirmation.success) {
    return NextResponse.json({ error: 'A typed confirmation is required.' }, { status: 400 });
  }

  const [segmentName] = await segmentNameFor(segmentId);
  if (confirmation.data.confirmation.trim() !== segmentName) {
    return NextResponse.json(
      { error: `Type the segment name exactly ("${segmentName}") to confirm.` },
      { status: 400 },
    );
  }

  // Any blocking finding, not only a file-level one (§9.4). The screen disables
  // Commit for the same reason; this is the half a stale tab cannot skip.
  if (plan.counts.blocking > 0) {
    return NextResponse.json(
      {
        error: `This import has ${plan.counts.blocking} blocking ${plan.counts.blocking === 1 ? 'issue' : 'issues'} and cannot be committed. Resolve them and dry run again.`,
      },
      { status: 409 },
    );
  }

  try {
    const outcome = await commitImport({
      target,
      filename: file.name,
      plan,
      uploadedBy: user.id,
    });

    await writeAuditLog({
      action: 'import.committed',
      entityType: 'import_batch',
      entityId: outcome.batchId,
      after: {
        filename: file.name,
        segmentId,
        registrations: outcome.createdRegistrations,
        attendees: outcome.createdAttendees,
        skipped: outcome.skippedParties,
        granted: outcome.granted,
      },
      reason: confirmation.data.confirmation,
    });

    return NextResponse.json({ ...payload, committed: true, outcome });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'The import failed.' },
      { status: 400 },
    );
  }
}

async function segmentNameFor(segmentId: number): Promise<[string]> {
  const { getDb } = await import('@/db/client');
  const { sql } = await import('drizzle-orm');
  const rows = await getDb().execute<{ name: string }>(
    sql`select name from show_segments where id = ${segmentId}`,
  );
  return [rows[0]?.name ?? ''];
}
