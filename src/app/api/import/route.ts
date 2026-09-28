import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getSessionUser } from '@/lib/auth/session';
import { writeAuditLog } from '@/lib/audit';
import { loadSegmentTarget } from '@/lib/import/context';
import {
  detectHeaderRow,
  distinctValues,
  ImportParseError,
  parseWorkbook,
  toSheetRows,
} from '@/lib/import/parse';
import { parseMappingProfile } from '@/lib/import/profile';
import { stageBatch } from '@/lib/import/staging';
import { suggestColumns } from '@/lib/import/template';

/**
 * The spreadsheet import endpoint (spec/import.md §9.1, §9.6).
 *
 * Node runtime, because `exceljs` is a Node module (spec/platform.md §16.1).
 *
 * **Two actions.** `inspect` reads the file for the mapping step and writes
 * nothing; `stage` lands its rows in `import_rows`, one per seat, for the
 * staging grid (spec/v3.md §25.7). The file itself is never stored: once
 * staged, each row keeps the cells it came from (`import_rows.raw`), and the
 * grid is edited and committed from those. V1's `dry-run` and `commit` are
 * retired with it (decision 49).
 *
 * **`ADMIN` only.** Import writes registrations for the whole segment; an
 * operator may not even export (spec/admin.md §14.3). `/api` is outside the
 * proxy matcher, so the check has to be here.
 */
export const runtime = 'nodejs';
export const maxDuration = 60;

const profileSchema = z.unknown();

const actionSchema = z.enum(['inspect', 'stage']);

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

  /**
   * V3 (spec/v3.md §25.7): the rows land in the staging grid, where they are
   * edited and committed a party at a time. Nothing is claimed here.
   */
  const staged = await stageBatch({
    target,
    filename: file.name,
    profile,
    rows,
    uploadedBy: user.id,
    queueReceipts: form.get('queueReceipts') === 'true',
  });
  await writeAuditLog({
    action: 'import.staged',
    entityType: 'import_batch',
    entityId: staged.batchId,
    after: { filename: file.name, segmentId, rows: staged.rows, emptyLines: staged.emptyLines },
  });
  return NextResponse.json(staged);
}
