import { NextResponse } from 'next/server';
import { sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { getSessionUser } from '@/lib/auth/session';
import { exportFilename } from '@/lib/export';
import { templateCsv, templateXlsx } from '@/lib/import/template-file';

/**
 * The "Download template" button of step 1 (spec/import.md §9.6).
 *
 * Node runtime for `exceljs` (spec/platform.md §16.1).
 */
export const runtime = 'nodejs';

export async function GET(request: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  if (user.role !== 'ADMIN') return NextResponse.json({ error: 'Admins only' }, { status: 403 });

  const url = new URL(request.url);
  const format = url.searchParams.get('format') === 'csv' ? 'csv' : 'xlsx';
  const concertId = Number(url.searchParams.get('concertId'));

  /**
   * The concert's zone, resolved rather than assumed (`CLAUDE.md`). Nothing in
   * the template is actually formatted against it — every cell is already a
   * string — but the shared export helper requires one, and a route that
   * defaulted to UTC here is the first place that rule would erode.
   */
  let timeZone = 'UTC';
  if (Number.isInteger(concertId) && concertId > 0) {
    const rows = await getDb().execute<{ timezone: string }>(
      sql`select timezone from concerts where id = ${concertId}`,
    );
    timeZone = rows[0]?.timezone ?? 'UTC';
  }

  if (format === 'csv') {
    return new NextResponse(templateCsv(timeZone), {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${exportFilename('import-template', 'csv')}"`,
        'Cache-Control': 'no-store',
      },
    });
  }

  const buffer = await templateXlsx(timeZone);
  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${exportFilename('import-template', 'xlsx')}"`,
      'Cache-Control': 'no-store',
    },
  });
}
