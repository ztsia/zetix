import 'server-only';
import ExcelJS from 'exceljs';
import { formatInZone, type ExportColumn, type ExportOptions } from './columns';

/**
 * A real `.xlsx` workbook.
 *
 * `exceljs` is a native-free pure-JS writer, so it runs anywhere a Route Handler
 * runs. It is still Node-only in practice, so **any route calling this needs
 * `export const runtime = 'nodejs'`** (`CLAUDE.md`).
 *
 * Timestamps are written as **text already formatted in the concert's zone**
 * rather than as Excel date serials. Excel date serials carry no timezone at
 * all, so the moment one is written the reader's machine decides what it means —
 * which is exactly the failure the "render in `concert.timezone`" rule exists to
 * prevent.
 */
/**
 * A worksheet name Excel will accept.
 *
 * Excel forbids `* ? : \ / [ ]` in a sheet name and caps it at 31 characters,
 * and `exceljs` enforces both by throwing. The name here comes from whatever the
 * caller is exporting, so left alone it turns ordinary data into a 500: a
 * concert called "Gala 2026/27" is enough, and the export route's `filename`
 * reaches this from a request body.
 *
 * Sanitising rather than rejecting is deliberate — the sheet's name is
 * cosmetic, and refusing an export because a concert has a slash in its title
 * would be a worse answer than naming the tab something close.
 */
export function safeSheetName(name: string | undefined): string {
  const cleaned = (name ?? '')
    .replace(/[*?:\\/[\]]/g, '-')
    .replace(/^'+|'+$/g, '')
    .trim()
    .slice(0, 31)
    // Edge separators only — a name that was *all* forbidden characters would
    // otherwise become a tab called "---".
    .replace(/^[-\s]+|[-\s]+$/g, '');
  return cleaned || 'Export';
}

export async function toXlsx<T>(
  rows: readonly T[],
  columns: readonly ExportColumn<T>[],
  options: ExportOptions,
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.created = new Date();
  const sheet = workbook.addWorksheet(safeSheetName(options.sheetName));

  sheet.columns = columns.map((column) => ({
    header: column.header,
    key: column.header,
    width: column.width ?? Math.max(12, Math.min(40, column.header.length + 6)),
  }));
  sheet.getRow(1).font = { bold: true };
  sheet.views = [{ state: 'frozen', ySplit: 1 }];

  for (const row of rows) {
    sheet.addRow(
      columns.map((column) => {
        const value = column.value(row);
        if (value === null || value === undefined) return '';
        if (value instanceof Date) return formatInZone(value, options.timeZone);
        if (typeof value === 'boolean') return value ? 'yes' : 'no';
        return value;
      }),
    );
  }

  sheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: Math.max(1, columns.length) },
  };

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}
