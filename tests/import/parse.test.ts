import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import {
  detectHeaderRow,
  distinctValues,
  ImportParseError,
  parseWorkbook,
  toSheetRows,
} from '@/lib/import/parse';

/**
 * Parsing is exercised against real files built with `exceljs` rather than
 * against fixtures of its output — a hand-written fixture would encode what we
 * believe the library returns, which is the assumption most worth testing
 * (spec/import.md §9.1).
 */

async function xlsx(rows: unknown[][], sheetName = 'Form Responses 1'): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheetName);
  rows.forEach((r) => ws.addRow(r));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe('parseWorkbook', () => {
  it('reads an xlsx sheet', async () => {
    const buf = await xlsx([
      ['Timestamp', 'Contact Name'],
      ['2026-09-01T10:00:00Z', 'Alice'],
    ]);
    const wb = await parseWorkbook(buf, 'round1.xlsx');

    expect(wb.sheets).toHaveLength(1);
    expect(wb.sheets[0].name).toBe('Form Responses 1');
    expect(wb.sheets[0].rows[0]).toEqual(['Timestamp', 'Contact Name']);
  });

  it('reads a csv', async () => {
    const csv = Buffer.from('Timestamp,Contact Name\n2026-09-01,Alice\n', 'utf8');
    const wb = await parseWorkbook(csv, 'round1.csv');

    expect(wb.sheets[0].rows[0]).toEqual(['Timestamp', 'Contact Name']);
    expect(wb.sheets[0].rows[1][1]).toBe('Alice');
  });

  /**
   * The one that matters for correctness: `requested_at` is the FCFS ordering
   * key (§7.4), and a date cell comes back as a `Date` while a text cell comes
   * back as a string. Both must reach the planner as something `new Date()`
   * reads the same way in every locale.
   */
  it('renders a real date cell as ISO rather than a locale string', async () => {
    const wb0 = new ExcelJS.Workbook();
    const ws = wb0.addWorksheet('S');
    ws.addRow(['Timestamp']);
    ws.addRow([new Date('2026-09-01T10:00:00Z')]);
    const buf = Buffer.from(await wb0.xlsx.writeBuffer());

    const wb = await parseWorkbook(buf, 'dates.xlsx');
    expect(wb.sheets[0].rows[1][0]).toBe('2026-09-01T10:00:00.000Z');
  });

  it('reads a formula cell as its computed result', async () => {
    const wb0 = new ExcelJS.Workbook();
    const ws = wb0.addWorksheet('S');
    ws.addRow(['Name']);
    ws.getCell('A2').value = { formula: 'CONCATENATE("Ali","ce")', result: 'Alice' };
    const buf = Buffer.from(await wb0.xlsx.writeBuffer());

    const wb = await parseWorkbook(buf, 'formulas.xlsx');
    expect(wb.sheets[0].rows[1][0]).toBe('Alice');
  });

  it('rejects an empty file', async () => {
    await expect(parseWorkbook(Buffer.alloc(0), 'empty.xlsx')).rejects.toThrow(ImportParseError);
  });

  it('rejects a file that is not a spreadsheet with a message naming it', async () => {
    const junk = Buffer.from('this is not a spreadsheet', 'utf8');
    await expect(parseWorkbook(junk, 'notes.xlsx')).rejects.toThrow(/notes\.xlsx/);
  });
});

describe('detectHeaderRow', () => {
  it('finds row 1 in a plain Google Form export', () => {
    expect(detectHeaderRow([['Timestamp', 'Email'], ['2026-09-01', 'a@b.com']])).toBe(1);
  });

  it('skips a title line above the headers', () => {
    expect(
      detectHeaderRow([
        ['Round 1 responses', ''],
        ['Timestamp', 'Email'],
        ['2026-09-01', 'a@b.com'],
      ]),
    ).toBe(2);
  });

  /** A header row names things; repeated values mean it is data. */
  it('skips a row with repeated values', () => {
    expect(
      detectHeaderRow([
        ['Extra', 'Extra', 'Extra'],
        ['Timestamp', 'Email', 'Name'],
      ]),
    ).toBe(2);
  });

  it('falls back to row 1 when nothing looks like a header', () => {
    expect(detectHeaderRow([[''], ['']])).toBe(1);
  });
});

describe('toSheetRows', () => {
  const sheet = {
    name: 'S',
    rows: [
      ['Timestamp', 'Contact Name', ''],
      ['2026-09-01', 'Alice', ''],
      ['', '', ''],
      ['2026-09-02', 'Bob', ''],
    ],
  };

  /**
   * Row numbers are spreadsheet lines, not array indices, so a finding the
   * admin reads says the same number their spreadsheet does. Bob is on line 4
   * even though he is the second data row and a blank line sits above him.
   */
  it('numbers rows by spreadsheet line and drops blank ones', () => {
    const { headers, rows } = toSheetRows(sheet, 1);

    expect(headers).toEqual(['Timestamp', 'Contact Name']);
    expect(rows.map((r) => r.rowNumber)).toEqual([2, 4]);
    expect(rows[1].cells['Contact Name']).toBe('Bob');
  });

  it('refuses a header row that does not exist', () => {
    expect(() => toSheetRows(sheet, 99)).toThrow(/does not exist/);
  });

  it('refuses an empty header row', () => {
    expect(() => toSheetRows({ name: 'S', rows: [['', ''], ['a', 'b']] }, 1)).toThrow(/no headers/);
  });
});

describe('distinctValues', () => {
  it('lists the values actually present, in first-seen order, ignoring blanks', () => {
    const rows = [
      { rowNumber: 2, cells: { Type: 'Allocated' } },
      { rowNumber: 3, cells: { Type: 'Extra' } },
      { rowNumber: 4, cells: { Type: '  ' } },
      { rowNumber: 5, cells: { Type: 'Allocated' } },
    ];

    expect(distinctValues(rows, 'Type')).toEqual(['Allocated', 'Extra']);
  });
});
