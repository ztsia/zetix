import { describe, expect, it } from 'vitest';
import { toCsv } from '../../src/lib/export/csv';
import { exportFilename, formatInZone, type ExportColumn } from '../../src/lib/export/columns';

type Row = { name: string; seats: number; confirmed: boolean; at: Date | null };

const columns: ExportColumn<Row>[] = [
  { header: 'Name', value: (r) => r.name },
  { header: 'Seats', value: (r) => r.seats },
  { header: 'Confirmed', value: (r) => r.confirmed },
  { header: 'Registered', value: (r) => r.at },
];

const SG = 'Asia/Singapore';

function rows(...values: Row[]) {
  return toCsv(values, columns, { timeZone: SG });
}

describe('CSV export', () => {
  it('starts with a UTF-8 BOM', () => {
    // Without it Excel on Windows reads the file as the system codepage and
    // mangles every non-ASCII name.
    expect(rows()).toMatch(/^﻿/);
  });

  it('keeps non-ASCII names intact', () => {
    const csv = rows({ name: 'Siti Nurhaliza binti Tarudin', seats: 2, confirmed: true, at: null });
    expect(csv).toContain('Siti Nurhaliza binti Tarudin');
    const withDiacritics = rows({ name: 'Zoë Ng', seats: 1, confirmed: true, at: null });
    expect(withDiacritics).toContain('Zoë Ng');
  });

  it('quotes and escapes commas, quotes and newlines', () => {
    const csv = rows({ name: 'Tan, Wei "Bee"\nLim', seats: 1, confirmed: false, at: null });
    expect(csv).toContain('"Tan, Wei ""Bee""\nLim"');
  });

  it('neutralises spreadsheet formula injection', () => {
    // Attendee names arrive from a public Google Form, so this is reachable
    // input. A leading = + - @ makes Excel treat the cell as a formula.
    for (const dangerous of ['=HYPERLINK("http://evil","x")', '+1+1', '-1+1', '@SUM(A1)']) {
      const csv = rows({ name: dangerous, seats: 0, confirmed: false, at: null });
      const line = csv.split('\r\n')[1];
      // The cell may also be quoted (it is, when the value contains a quote or
      // comma), so look past an opening quote before checking the guard.
      const cell = line.startsWith('"') ? line.slice(1) : line;
      expect(cell.startsWith("'")).toBe(true);
      expect(cell).not.toMatch(/^[=+\-@]/);
    }
  });

  it('renders timestamps in the concert zone, not the runner zone', () => {
    // 2026-09-19T15:30Z is 23:30 the same day in Singapore.
    const at = new Date('2026-09-19T15:30:00Z');
    const csv = rows({ name: 'A', seats: 1, confirmed: true, at });
    expect(csv).toContain('2026-09-19 23:30');
  });

  it('writes booleans and nulls readably', () => {
    const csv = rows({ name: 'A', seats: 0, confirmed: false, at: null });
    const line = csv.split('\r\n')[1];
    expect(line).toBe('A,0,no,');
  });
});

describe('formatInZone', () => {
  it('crosses the date boundary correctly', () => {
    // 16:00Z on the 18th is 00:00 on the 19th in Singapore — and must not
    // render as hour 24.
    expect(formatInZone(new Date('2026-09-18T16:00:00Z'), SG)).toBe('2026-09-19 00:00');
  });

  it('gives different answers for different zones', () => {
    const instant = new Date('2026-09-19T15:30:00Z');
    expect(formatInZone(instant, SG)).not.toBe(formatInZone(instant, 'Europe/London'));
  });
});

describe('exportFilename', () => {
  it('slugifies and dates the name', () => {
    expect(exportFilename('Extras review', 'csv', new Date('2026-09-19T00:00:00Z'))).toBe(
      'extras-review-2026-09-19.csv',
    );
  });
});
