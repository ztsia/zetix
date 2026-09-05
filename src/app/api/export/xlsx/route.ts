import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getSessionUser } from '@/lib/auth/session';
import { exportFilename, type ExportColumn } from '@/lib/export';
import { toXlsx } from '@/lib/export/xlsx';

/**
 * Turns a flattened table view into an `.xlsx` download.
 *
 * `exceljs` is a Node module, so this cannot run on the Edge — and the admin
 * bundle should not carry a spreadsheet writer either. The client flattens the
 * rows it is already showing and posts the matrix here (`CLAUDE.md`).
 *
 * **Generic on purpose.** It takes headers and cells, not a table name, so no
 * module needs its own export endpoint and none can accidentally widen what a
 * caller may read: the rows arrive from the caller's own screen, so this route
 * discloses nothing it was not already shown.
 *
 * It is still `ADMIN`-only. Operators may not export at all (spec/admin.md §14.3),
 * and `/api` is excluded from the proxy matcher, so the check has to be here.
 */
export const runtime = 'nodejs';

const CELL_LIMIT = 200_000;

const cellSchema = z.union([
  z.string(),
  z.number(),
  z.object({ date: z.string() }),
]);

const bodySchema = z.object({
  filename: z.string().min(1).max(120),
  sheetName: z.string().min(1).max(120).optional(),
  headers: z.array(z.string()).min(1).max(200),
  widths: z.array(z.number().nullable()).optional(),
  rows: z.array(z.array(cellSchema)),
  timeZone: z.string().min(1),
});

export async function POST(request: Request) {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  }
  if (user.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Admins only' }, { status: 403 });
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Malformed export request' }, { status: 400 });
  }
  const { filename, sheetName, headers, widths, rows, timeZone } = parsed.data;

  // `Intl` throws a RangeError on an unknown zone, and this value comes from the
  // request body. Rejecting it here turns a 500 into a 400 that names the cause.
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone });
  } catch {
    return NextResponse.json({ error: `Unknown timezone "${timeZone}"` }, { status: 400 });
  }

  // A runaway export would build the whole workbook in memory inside a function
  // with a hard time limit. Refusing is better than a 504 with no explanation.
  if (rows.length * headers.length > CELL_LIMIT) {
    return NextResponse.json(
      { error: 'That export is too large. Narrow the filters and try again.' },
      { status: 413 },
    );
  }

  // Each incoming row is already a flat array of cells, so the export columns are
  // synthesised by position. The workbook itself is built by the shared helper —
  // this route formats nothing of its own.
  type Cell = (typeof rows)[number][number];
  const columns: ExportColumn<Cell[]>[] = headers.map((header, index) => ({
    header,
    width: widths?.[index] ?? undefined,
    value: (row) => {
      const cell = row[index];
      // A timestamp arrives as `{ date: <ISO instant> }`; handing back a `Date`
      // lets the helper render it in the concert's zone, as text. An Excel date
      // serial carries no zone, so writing one would hand the reader's machine
      // the decision about what time it is (`CLAUDE.md`).
      if (cell && typeof cell === 'object') return new Date(cell.date);
      return cell ?? '';
    },
  }));

  const buffer = await toXlsx(rows, columns, { timeZone, sheetName: sheetName ?? filename });

  // `toXlsx` returns a Node Buffer; hand the Response its bytes.
  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      'Content-Type':
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${exportFilename(filename, 'xlsx')}"`,
      'Cache-Control': 'no-store',
    },
  });
}
