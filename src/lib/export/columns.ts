/**
 * The shared shape of an export (spec/admin.md §14.1 — `/exports`, "CSV/XLSX of
 * any table view").
 *
 * Columns are declared separately from the `DataTable` column definitions on
 * purpose. A table column renders React — badges, row actions, a truncated name
 * with a tooltip — and none of that means anything in a spreadsheet. An export
 * column returns a *value*, so the same row can render richly on screen and
 * flatly in a file without either one compromising for the other.
 */
/**
 * The most cells one XLSX export may hold. `/api/export/xlsx` refuses beyond
 * it, and the export menu says so before the request rather than after.
 *
 * A request-size bound on a server-side spreadsheet writer, not an operational
 * value: nothing here comes from `context.md`. CSV, built in the browser, has
 * no such bound.
 */
export const XLSX_CELL_LIMIT = 200_000;

export type ExportValue = string | number | boolean | Date | null | undefined;

export type ExportColumn<T> = {
  /** Column header text, as written in the file. */
  header: string;
  value: (row: T) => ExportValue;
  /** Approximate character width, used for XLSX column sizing only. */
  width?: number;
};

export type ExportOptions = {
  /**
   * The concert's timezone. **Always pass it.** Timestamps render in
   * `concert.timezone`, never the viewer's zone (`CLAUDE.md`) — an export opened
   * by a committee member travelling must show the same door time as the ticket.
   */
  timeZone: string;
  sheetName?: string;
};

/** `registrations-2026-09-19.csv` — sortable, and safe on every filesystem. */
export function exportFilename(base: string, extension: 'csv' | 'xlsx', now = new Date()): string {
  const slug = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${slug}-${now.toISOString().slice(0, 10)}.${extension}`;
}

/**
 * Formats a timestamp in the concert's zone, as `YYYY-MM-DD HH:mm`.
 *
 * Not ISO-with-offset, because Excel does not parse that into a date and leaves
 * it as text; not a locale string, because the ordering would then depend on
 * whoever opened the file.
 */
export function formatInZone(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  // en-CA gives ISO-ordered date parts; hour can come back as "24" at midnight.
  const hour = get('hour') === '24' ? '00' : get('hour');
  return `${get('year')}-${get('month')}-${get('day')} ${hour}:${get('minute')}`;
}
