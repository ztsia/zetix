import 'server-only';
import { toCsv, type ExportColumn } from '@/lib/export';
import { toXlsx } from '@/lib/export/xlsx';
import { TEMPLATE_EXAMPLE_ROWS, TEMPLATE_HEADERS } from './template';

/**
 * Turns the template constants into a downloadable file (spec/import.md §9.6).
 *
 * Separate from `template.ts` because `exceljs` is a Node module and the step-1
 * example table renders on the client from the same constants. Keeping the
 * writer here is what stops a spreadsheet library reaching the admin bundle.
 */

type Row = Record<string, string>;

const columns: ExportColumn<Row>[] = Object.values(TEMPLATE_HEADERS).map((header) => ({
  header,
  value: (row) => row[header] ?? '',
  width: header === TEMPLATE_HEADERS.timestamp ? 22 : 24,
}));

/**
 * `timeZone` is required by the shared export helper and is genuinely unused
 * here — every template cell is already a string, so nothing is formatted
 * against a zone. It is passed rather than defaulted because the helper's
 * contract is "always pass it", and a template that quietly picked UTC would be
 * the first place that rule eroded.
 */
export async function templateXlsx(timeZone: string): Promise<Buffer> {
  return toXlsx(TEMPLATE_EXAMPLE_ROWS, columns, { timeZone, sheetName: 'Registrations' });
}

export function templateCsv(timeZone: string): string {
  return toCsv(TEMPLATE_EXAMPLE_ROWS, columns, { timeZone });
}
