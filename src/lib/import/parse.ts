import ExcelJS from 'exceljs';
import type { SheetRow } from './plan';

/**
 * Spreadsheet parsing (spec/import.md §9.1).
 *
 * **Parsed once, server-side.** §9.1 originally had SheetJS parse in the browser
 * for preview and again on the server for the commit, so the client could not
 * forge rows. Parsing only on the server gives that property with one parser
 * instead of two — and two parsers of the same file are two chances to disagree
 * about what row 14 says.
 *
 * `exceljs` reads both `.xlsx` and `.csv` and is already a dependency (it writes
 * the admin exports), so this adds nothing to the bundle. Any route calling it
 * needs `export const runtime = 'nodejs'` (spec/platform.md §16.1).
 */

export type ParsedSheet = {
  name: string;
  /** Every row as text, including the header row. 1-based by index + 1. */
  rows: string[][];
};

export type ParsedWorkbook = {
  sheets: ParsedSheet[];
};

/**
 * The largest file worth accepting. Not an operational value in the
 * `CLAUDE.md` sense — it is not a capacity, quota, deadline, cap, batch size or
 * rate limit, but a guard on how much a single request may allocate. A Google
 * Form export of a few hundred rows is tens of kilobytes; a megabyte is already
 * two orders of magnitude of headroom.
 */
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

export class ImportParseError extends Error {}

/**
 * Renders a cell as the text a person would see in the spreadsheet.
 *
 * Dates are the case that matters: `requested_at` is the FCFS ordering key
 * (§7.4), and `exceljs` hands back a real `Date` for a date-formatted cell but
 * a string for a text-formatted one. Both become ISO here so the planner reads
 * one format and `new Date()` cannot fall back to locale guessing on a
 * "01/09/2026" that could be either day or month first.
 */
function cellText(value: ExcelJS.CellValue): string {
  if (value == null) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (typeof value === 'object') {
    const v = value as unknown as Record<string, unknown>;
    // A formula cell carries its computed result; a hyperlink carries its text;
    // rich text carries runs. Reading `.result`/`.text` rather than the wrapper
    // is the difference between "alice@example.com" and "[object Object]".
    if ('result' in v) return cellText(v.result as ExcelJS.CellValue);
    if ('text' in v && typeof v.text === 'string') return v.text;
    if ('richText' in v && Array.isArray(v.richText)) {
      return (v.richText as { text?: string }[]).map((r) => r.text ?? '').join('');
    }
    if ('error' in v) return '';
  }
  return String(value);
}

function readSheet(ws: ExcelJS.Worksheet): ParsedSheet {
  const rows: string[][] = [];
  // `rowCount` counts to the last row with any content; a sparse sheet leaves
  // holes, and `getRow(n)` on a hole returns an empty row rather than throwing.
  for (let n = 1; n <= ws.rowCount; n += 1) {
    const row = ws.getRow(n);
    const cells: string[] = [];
    for (let c = 1; c <= ws.columnCount; c += 1) {
      cells.push(cellText(row.getCell(c).value));
    }
    rows.push(cells);
  }
  return { name: ws.name, rows };
}

export async function parseWorkbook(
  bytes: Buffer | ArrayBuffer,
  filename: string,
): Promise<ParsedWorkbook> {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (buffer.byteLength === 0) throw new ImportParseError('That file is empty.');
  if (buffer.byteLength > MAX_UPLOAD_BYTES) {
    throw new ImportParseError(
      `That file is ${(buffer.byteLength / 1024 / 1024).toFixed(1)}MB, above the ${MAX_UPLOAD_BYTES / 1024 / 1024}MB limit.`,
    );
  }

  const isCsv = /\.csv$/i.test(filename);
  const workbook = new ExcelJS.Workbook();

  try {
    if (isCsv) {
      // `csv.read` takes a stream. A CSV has exactly one sheet, named after the
      // file by exceljs, which is why the sheet picker is skipped for CSV.
      const { Readable } = await import('node:stream');
      await workbook.csv.read(Readable.from(buffer));
    } else {
      // exceljs types its own Buffer; the runtime value is a Node Buffer.
      await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);
    }
  } catch (error) {
    throw new ImportParseError(
      `Could not read ${filename} as a ${isCsv ? 'CSV' : 'spreadsheet'}. ${
        error instanceof Error ? error.message : 'The file may be corrupt or password-protected.'
      }`,
    );
  }

  const sheets = workbook.worksheets.map(readSheet).filter((s) => s.rows.length > 0);
  if (sheets.length === 0) throw new ImportParseError(`${filename} has no readable sheets.`);
  return { sheets };
}

/**
 * Guesses which row holds the headers.
 *
 * A Google Form export has them on row 1, but a sheet an admin has normalized by
 * hand often carries a title or a blank line first. The guess is the first row
 * whose cells are mostly non-empty and all distinct — a header row names things,
 * so repeats mean data. It is only ever a preselection: §9.6 shows the following
 * rows underneath so the admin verifies rather than trusts it.
 */
export function detectHeaderRow(rows: readonly string[][]): number {
  for (let i = 0; i < Math.min(rows.length, 20); i += 1) {
    const cells = rows[i].map((c) => c.trim());
    const filled = cells.filter((c) => c !== '');
    if (filled.length < 2) continue;
    if (filled.length / cells.length < 0.5) continue;
    if (new Set(filled).size !== filled.length) continue;
    return i + 1;
  }
  return 1;
}

/**
 * Turns a sheet into the planner's rows.
 *
 * `rowNumber` is the **spreadsheet** line, not an index into the result, so a
 * finding the admin reads says the same number their spreadsheet does. Blank
 * lines are dropped rather than reported: a trailing empty row is how
 * spreadsheets are, not something a person did wrong.
 */
export function toSheetRows(sheet: ParsedSheet, headerRow: number): {
  headers: string[];
  rows: SheetRow[];
} {
  const headerIndex = headerRow - 1;
  const rawHeaders = sheet.rows[headerIndex];
  if (!rawHeaders) {
    throw new ImportParseError(
      `Row ${headerRow} does not exist in "${sheet.name}" — it has ${sheet.rows.length} rows.`,
    );
  }

  // Trailing empty columns are an artifact of `columnCount`, not real columns.
  const headers = rawHeaders.map((h) => h.trim());
  while (headers.length > 0 && headers[headers.length - 1] === '') headers.pop();
  if (headers.every((h) => h === '')) {
    throw new ImportParseError(`Row ${headerRow} of "${sheet.name}" is empty, so it has no headers.`);
  }

  const rows: SheetRow[] = [];
  for (let i = headerIndex + 1; i < sheet.rows.length; i += 1) {
    const raw = sheet.rows[i];
    if (raw.every((c) => c.trim() === '')) continue;
    const cells: Record<string, string> = {};
    headers.forEach((header, c) => {
      if (header === '') return;
      cells[header] = raw[c] ?? '';
    });
    rows.push({ rowNumber: i + 1, cells });
  }

  return { headers: headers.filter((h) => h !== ''), rows };
}

/**
 * The distinct values present in one column, in first-seen order.
 *
 * This is what makes the allocation-type mapping correct by construction
 * (§9.6): the screen lists what the file actually contains instead of asking the
 * admin to type values, so a value that maps to nothing is visible rather than
 * guessed at.
 */
export function distinctValues(rows: readonly SheetRow[], column: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const row of rows) {
    const v = (row.cells[column] ?? '').trim();
    if (v === '' || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}
