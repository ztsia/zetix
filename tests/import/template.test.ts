import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { parseWorkbook, toSheetRows } from '@/lib/import/parse';
import { planImport, type PlanContext } from '@/lib/import/plan';
import { parseMappingProfile } from '@/lib/import/profile';
import {
  TEMPLATE_HEADERS,
  defaultProfileFor,
  suggestColumns,
} from '@/lib/import/template';
import { templateCsv, templateXlsx } from '@/lib/import/template-file';

/**
 * The template is the load-bearing half of step 1 (spec/import.md §9.6): an
 * admin who fills it in should get a file that maps itself. That promise is only
 * true if the template's own headers, the suggested mapping and the default
 * profile agree — three things in two modules that would otherwise drift apart
 * silently, and whose drift looks like "the mapping step is just broken".
 */

const baseContext: PlanContext = {
  audienceMode: 'PUBLIC',
  extrasPolicy: 'AUTO_FCFS',
  baseQuota: null,
  maxTicketsPerResponse: null,
  openSeats: 100,
  extrasPool: 100,
  baseAlreadyClaimed: new Map(),
  playersWithExistingRegistration: new Set(),
  playerMatches: new Map(),
};

describe('the template maps itself', () => {
  it('round-trips: the generated file parses, suggests, and plans with no findings', async () => {
    const buffer = await templateXlsx('Asia/Kuala_Lumpur');
    const workbook = await parseWorkbook(buffer, 'import-template.xlsx');
    const { headers, rows } = toSheetRows(workbook.sheets[0], 1);

    // 1. Every template header survived the write/read round trip.
    expect(headers).toEqual(Object.values(TEMPLATE_HEADERS));

    // 2. Auto-suggestion maps all of them, with nothing left for the admin.
    const suggested = suggestColumns(headers);
    expect(suggested).toEqual({
      requested_at: TEMPLATE_HEADERS.timestamp,
      contact_name: TEMPLATE_HEADERS.contactName,
      contact_email: TEMPLATE_HEADERS.contactEmail,
      attendee_name: TEMPLATE_HEADERS.attendeeName,
      attendee_email: TEMPLATE_HEADERS.attendeeEmail,
      allocation_type: TEMPLATE_HEADERS.ticketType,
      group_key: null,
    });

    // 3. The default profile plans the example rows cleanly on the path the
    //    screen actually builds for a player-invited segment: the allocation
    //    column mapped, "Allocated" reading as BASE.
    const profile = parseMappingProfile({
      ...defaultProfileFor('EXTRA'),
      player_match: { column: TEMPLATE_HEADERS.contactEmail, strategy: 'EMAIL' },
    });
    const plan = planImport(rows, profile, {
      ...baseContext,
      audienceMode: 'PLAYER_INVITED',
      extrasPolicy: 'REVIEW',
      baseQuota: 2,
      playerMatches: new Map([
        ['alice@example.com', { playerId: 1, fullName: 'Alice Tan', confidence: 1, needsConfirmation: false }],
        ['carol@example.com', { playerId: 2, fullName: 'Carol Lim', confidence: 1, needsConfirmation: false }],
      ]),
    });

    expect(plan.counts.blocking).toBe(0);
    expect(plan.counts.parties).toBe(2);
    expect(plan.counts.seats).toBe(4);
    expect(plan.largestParty).toBe(3);
    expect(plan.counts.placeholderNames).toBe(1);
    // Alice has two BASE within her quota of 2, plus one EXTRA already marked
    // as such in the sheet; nothing needed promoting.
    expect(plan.counts.baseSeats).toBe(3);
    expect(plan.counts.promotedToExtra).toBe(0);
  });

  /**
   * The public path, as the screen builds it: the allocation column is left
   * unmapped and every seat defaults to EXTRA (§9.5). Without that, the
   * template's own "Allocated" rows would block on BASE_IN_PUBLIC_SEGMENT —
   * which is the correct refusal, and the reason the screen locks the control.
   */
  it('plans cleanly for a public segment when the screen unmaps the type column', async () => {
    const buffer = await templateXlsx('UTC');
    const workbook = await parseWorkbook(buffer, 'import-template.xlsx');
    const { rows } = toSheetRows(workbook.sheets[0], 1);

    const forPublic = defaultProfileFor('EXTRA');
    const profile = parseMappingProfile({
      ...forPublic,
      columns: { ...forPublic.columns, allocation_type: null },
    });
    const plan = planImport(rows, profile, baseContext);

    expect(plan.counts.blocking).toBe(0);
    expect(plan.counts.seats).toBe(4);
    expect(plan.counts.baseSeats).toBe(0);
    expect(plan.counts.extraSeats).toBe(4);
  });

  /** And the refusal itself, so the lock in the UI is not the only guard. */
  it('blocks the template as-is against a public segment', async () => {
    const buffer = await templateXlsx('UTC');
    const workbook = await parseWorkbook(buffer, 'import-template.xlsx');
    const { rows } = toSheetRows(workbook.sheets[0], 1);

    const plan = planImport(rows, parseMappingProfile(defaultProfileFor('EXTRA')), baseContext);

    expect(plan.findings.some((f) => f.code === 'BASE_IN_PUBLIC_SEGMENT')).toBe(true);
    expect(plan.counts.blocking).toBeGreaterThan(0);
  });

  it('produces a csv that parses to the same rows', async () => {
    const csv = templateCsv('Asia/Kuala_Lumpur');
    const workbook = await parseWorkbook(Buffer.from(csv, 'utf8'), 'import-template.csv');
    const { rows } = toSheetRows(workbook.sheets[0], 1);
    expect(rows).toHaveLength(4);
  });

  /**
   * The example is the explanation, so if it stops demonstrating the grouping
   * rule the step silently stops teaching it. Alice's three rows must repeat the
   * same contact email and timestamp; Carol's must differ.
   */
  it('keeps the worked example demonstrating the grouping rule', async () => {
    const buffer = await templateXlsx('UTC');
    const workbook = await parseWorkbook(buffer, 't.xlsx');
    const { rows } = toSheetRows(workbook.sheets[0], 1);

    const keyOf = (i: number) =>
      `${rows[i].cells[TEMPLATE_HEADERS.contactEmail]}|${rows[i].cells[TEMPLATE_HEADERS.timestamp]}`;

    expect(keyOf(0)).toBe(keyOf(1));
    expect(keyOf(1)).toBe(keyOf(2));
    expect(keyOf(3)).not.toBe(keyOf(0));
    expect(rows[2].cells[TEMPLATE_HEADERS.attendeeName]).toBe('');
  });
});

describe('suggestColumns', () => {
  /**
   * The bug this guards: "Name" is a candidate for `contact_name`, and a
   * containment match happily finds it inside "Attendee Name". Without
   * claiming exact matches first and using each header once, two targets map
   * onto one column and the import silently reads attendee names as contacts.
   */
  it('does not let a loose candidate steal a column an exact match owns', () => {
    const s = suggestColumns(['Timestamp', 'Contact Name', 'Attendee Name']);
    expect(s.contact_name).toBe('Contact Name');
    expect(s.attendee_name).toBe('Attendee Name');
  });

  it('separates contact and attendee email when both are present', () => {
    const s = suggestColumns(['Email Address', 'Attendee Email']);
    expect(s.attendee_email).toBe('Attendee Email');
    expect(s.contact_email).toBe('Email Address');
  });

  it('never maps two targets onto the same header', () => {
    const s = suggestColumns(['Timestamp', 'Name', 'Email', 'Type']);
    const used = Object.values(s).filter((v): v is string => v !== null);
    expect(new Set(used).size).toBe(used.length);
  });

  it('matches a decorated header by containment', () => {
    const s = suggestColumns(['Timestamp (GMT+8)', 'Your name', 'Email Address']);
    expect(s.requested_at).toBe('Timestamp (GMT+8)');
    expect(s.contact_name).toBe('Your name');
  });

  it('leaves a target null rather than guessing when nothing matches', () => {
    const s = suggestColumns(['Column A', 'Column B']);
    expect(s.requested_at).toBeNull();
    expect(s.contact_name).toBeNull();
  });

  it('is case- and punctuation-insensitive', () => {
    const s = suggestColumns(['TIMESTAMP', 'contact_name', 'ticket type']);
    expect(s.requested_at).toBe('TIMESTAMP');
    expect(s.contact_name).toBe('contact_name');
    expect(s.allocation_type).toBe('ticket type');
  });
});

describe('the template file itself', () => {
  it('names the sheet so the picker is skippable', async () => {
    const buffer = await templateXlsx('UTC');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as unknown as Parameters<typeof wb.xlsx.load>[0]);
    expect(wb.worksheets[0].name).toBe('Registrations');
  });
});
