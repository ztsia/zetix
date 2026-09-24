import { NextResponse, type NextRequest } from 'next/server';
import { sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { getSessionUser } from '@/lib/auth/session';
import { exportFilename, toCsv, type ExportColumn } from '@/lib/export';
import { loadNotesScreen, type AdminNote } from '@/app/(admin)/admin/concerts/[concertId]/notes/queries';

/**
 * `GET /api/notes/export` — a player's notes as CSV (spec/admin.md §14.2).
 *
 * **A route rather than a Server Action** because an Action cannot stream a
 * file back to a download. It is the same reason the booklet upload is a route
 * and the booklet's publish flag is an Action.
 *
 * **Authorized as an admin, and that is the whole boundary.** §14.2 makes the
 * grouped-by-player view admin-only always, whatever
 * `portal.public_wall_visibility` says (decision 6), and this file is that view
 * in a spreadsheet: every note, attributed, including the names of writers who
 * asked the *wall* not to show them. A URL that served this to anybody else
 * would undo the setting without touching it.
 */

export const runtime = 'nodejs';

/**
 * §14.2 names PDF and CSV. **CSV ships; PDF does not**, and the gap is
 * deliberate rather than forgotten: `pdf-lib` is already a dependency for
 * tickets, but a ticket is a fixed canvas and a notes export is reflowing prose
 * of unknown length — a different renderer, with pagination and text wrapping
 * of its own. The thing an admin does with this file is read it and copy notes
 * into a programme or an email, which a spreadsheet does better than a PDF.
 * `docs/local.md` carries the item; a session that needs the PDF should build
 * it knowing that is what it is for.
 */
const COLUMNS: ExportColumn<AdminNote & { addressedTo: string }>[] = [
  { header: 'Written to', value: (n) => n.addressedTo, width: 24 },
  { header: 'Note', value: (n) => n.body, width: 60 },
  { header: 'Signed as', value: (n) => n.displayName ?? n.attendeeName, width: 20 },
  /**
   * The writer's real name, beside the name they signed. §13.4 hides an
   * anonymous name from the wall "but never from admin", and this is admin.
   * Both columns are present because they differ: a guest may sign a nickname
   * without being anonymous at all.
   */
  { header: 'Attendee', value: (n) => n.attendeeName, width: 20 },
  { header: 'Anonymous on the wall', value: (n) => n.isAnonymous, width: 10 },
  { header: 'Show', value: (n) => n.showName, width: 20 },
  { header: 'Review', value: (n) => n.moderationStatus, width: 12 },
  { header: 'Wall', value: (n) => n.wallStatus, width: 14 },
  { header: 'Left at', value: (n) => n.createdAt, width: 18 },
];

export async function GET(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  if (user.role !== 'ADMIN') return NextResponse.json({ error: 'Admins only' }, { status: 403 });

  const params = request.nextUrl.searchParams;
  /**
   * **`isSafeInteger`, not `isInteger`.** Forty digits parses to a finite
   * float that `Number.isInteger` happily accepts, and Postgres then rejects
   * `1e+40` as a bigint with a `22P02` that reaches the client as a 500. The
   * bound is the language's, not this concert's — every id in the schema is a
   * bigint identity, and nothing above 2^53 was ever going to name a row.
   */
  const concertId = Number(params.get('concertId'));
  if (!Number.isSafeInteger(concertId) || concertId <= 0) {
    return NextResponse.json({ error: 'A concert is required.' }, { status: 400 });
  }

  /**
   * An absent `playerIds` means every note on the concert, which is what the
   * button sends when nothing is selected. An empty or unparseable list is the
   * same as absent rather than an error: the control cannot produce one, and a
   * 400 from a download link is a dead end with nowhere to show the message.
   */
  const wanted = new Set(
    (params.get('playerIds') ?? '')
      .split(',')
      .map((part) => Number(part.trim()))
      .filter((id) => Number.isSafeInteger(id) && id > 0),
  );

  const screen = await loadNotesScreen(concertId);
  if (!screen) return NextResponse.json({ error: 'No such concert.' }, { status: 404 });

  const [zone] = await getDb().execute<{ timezone: string | null }>(sql`
    select timezone from concerts where id = ${concertId} limit 1
  `);

  const rows = screen.groups
    .filter((group) => wanted.size === 0 || (group.playerId !== null && wanted.has(group.playerId)))
    .flatMap((group) =>
      group.notes.map((note) => ({ ...note, addressedTo: group.playerName })),
    );

  const csv = toCsv(rows, COLUMNS, {
    /**
     * Every timestamp renders in the concert's zone, never the viewer's
     * (`CLAUDE.md`). UTC only when the concert has no zone set — which is a
     * configuration gap, not a default, and showing the raw instant is more
     * honest than silently using the server's.
     */
    timeZone: zone?.timezone ?? 'UTC',
  });

  return new NextResponse(csv, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${exportFilename('notes', 'csv')}"`,
      /** Never cached: it is a roster of what the audience said, by name. */
      'cache-control': 'no-store',
    },
  });
}
