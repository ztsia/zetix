import { describe, expect, it } from 'vitest';
import { safeSheetName, toXlsx } from '../../src/lib/export/xlsx';
import type { ExportColumn } from '../../src/lib/export/columns';

/**
 * Excel forbids `* ? : \ / [ ]` in a worksheet name and caps it at 31
 * characters, and `exceljs` enforces both by throwing. The name comes from
 * whatever is being exported, so unsanitised it turns ordinary data into a 500.
 */
describe('safeSheetName', () => {
  it('replaces the characters Excel forbids', () => {
    expect(safeSheetName('Gala 2026/27')).toBe('Gala 2026-27');
    expect(safeSheetName('a[b]c*d?e:f\\g')).toBe('a-b-c-d-e-f-g');
  });

  it('truncates to Excel’s 31-character limit', () => {
    expect(safeSheetName('x'.repeat(80))).toHaveLength(31);
  });

  it('never returns an empty name', () => {
    // An empty worksheet name throws just as loudly as a forbidden character.
    expect(safeSheetName('')).toBe('Export');
    expect(safeSheetName(undefined)).toBe('Export');
    expect(safeSheetName('///')).toBe('Export');
  });

  it('strips wrapping apostrophes, which Excel also rejects', () => {
    expect(safeSheetName("'Concerts'")).toBe('Concerts');
  });
});

type Row = { name: string; at: Date | null };
const columns: ExportColumn<Row>[] = [
  { header: 'Name', value: (r) => r.name },
  { header: 'When', value: (r) => r.at },
];

describe('toXlsx', () => {
  it('writes a real xlsx, whatever the sheet name was', async () => {
    const buffer = await toXlsx([{ name: 'Alice Tan', at: null }], columns, {
      timeZone: 'Asia/Singapore',
      sheetName: '../../../etc/passwd',
    });
    // A .xlsx is a zip: it starts with the local file header magic.
    expect(Array.from(buffer.subarray(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04]);
  });

  it('renders timestamps in the concert zone, not the runner zone', async () => {
    const buffer = await toXlsx(
      [{ name: 'A', at: new Date('2026-09-19T15:30:00Z') }],
      columns,
      { timeZone: 'Asia/Singapore' },
    );
    // The zip is deflated, so assert on what a reader would see by round-tripping
    // through exceljs rather than grepping bytes.
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as unknown as ArrayBuffer);
    const cell = wb.worksheets[0].getRow(2).getCell(2).value;
    expect(String(cell)).toBe('2026-09-19 23:30');
  });
});
