import { formatInZone, type ExportColumn, type ExportOptions, type ExportValue } from './columns';

/**
 * A leading `=`, `+`, `-`, `@`, tab or carriage return makes a spreadsheet treat
 * a cell as a formula. Attendee names and emails arrive from a public Google
 * Form, so this is reachable input, not a theoretical one: a name of
 * `=HYPERLINK("http://evil","click")` becomes a live link in a committee
 * member's Excel.
 *
 * Prefixing with an apostrophe is the standard neutralisation — Excel and
 * LibreOffice both read it as "this is text" and do not display it.
 */
const FORMULA_LEAD = /^[=+\-@\t\r]/;

function cell(value: ExportValue, timeZone: string): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return formatInZone(value, timeZone);
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (typeof value === 'number') return String(value);
  return value;
}

function quote(text: string): string {
  const escaped = FORMULA_LEAD.test(text) ? `'${text}` : text;
  if (/[",\r\n]/.test(escaped)) return `"${escaped.replace(/"/g, '""')}"`;
  return escaped;
}

/**
 * RFC 4180 CSV, with a UTF-8 BOM.
 *
 * The BOM is not decoration: without it Excel on Windows reads the file as the
 * system codepage and mangles every non-ASCII name — which, for this orchestra's
 * audience, is a great many of them.
 */
export function toCsv<T>(
  rows: readonly T[],
  columns: readonly ExportColumn<T>[],
  options: ExportOptions,
): string {
  const lines = [columns.map((c) => quote(c.header)).join(',')];
  for (const row of rows) {
    lines.push(columns.map((c) => quote(cell(c.value(row), options.timeZone))).join(','));
  }
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}
