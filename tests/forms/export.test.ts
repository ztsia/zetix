import { describe, expect, it } from 'vitest';
import { buildExportTable, type ExportableResponse } from '@/lib/forms/export';
import { addCustomBlock, addField, updateField } from '@/app/(admin)/admin/concerts/[concertId]/forms/builder/operations';
import { blankFormSchema } from '@/lib/forms/templates';
import type { FormSchema } from '@/lib/forms/schema';

/**
 * The export's three rules (spec/v2.md §8.5).
 *
 * Rule 1 is the counterintuitive one and gets the most tests: **columns come
 * from the pinned schema, not from the responses.** The obvious implementation
 * — walk the answers, collect the keys — passes a naive test and silently drops
 * every question nobody answered, which is exactly the column somebody
 * reconciling a sheet is looking for.
 */

const META = [
  { header: 'Response', key: 'Response' },
  { header: 'Submitted', key: 'Submitted' },
];

function response(
  id: number,
  schema: FormSchema,
  payload: Record<string, unknown>,
  submittedAt = new Date(`2026-09-0${id}T10:00:00Z`),
): ExportableResponse {
  return {
    id,
    formSchema: schema,
    payload,
    submittedAt,
    meta: { Response: id, Submitted: submittedAt.toISOString() },
  };
}

/** A public form with one custom question, which is the shape most rules need. */
function publicForm(): FormSchema {
  let schema = addCustomBlock(blankFormSchema('PUBLIC'), 'Extras');
  const index = schema.blocks.length - 1;
  schema = addField(schema, index, 'Accessibility needs');
  return schema;
}

function headerIndex(headers: string[], name: string): number {
  const index = headers.indexOf(name);
  expect(index, `no column named "${name}" in ${headers.join(' | ')}`).toBeGreaterThanOrEqual(0);
  return index;
}

describe('columns come from the pinned schema, not the responses', () => {
  it('gives a question nobody answered a column of its own', () => {
    const schema = publicForm();
    const table = buildExportTable(
      [
        response(1, schema, {
          registrant: { kind: 'flat', values: { contact_name: 'Ada', contact_email: 'ada@x.test' } },
          party: { kind: 'repeater', rows: [] },
          // `accessibility_needs` is simply absent: nobody answered it.
        }),
      ],
      META,
    );

    const column = headerIndex(table.headers, 'Accessibility needs');
    expect(table.rows[0][column]).toBe('');
  });

  it('keeps the admin’s question order, not the payload’s', () => {
    const schema = publicForm();
    const table = buildExportTable(
      [
        response(1, schema, {
          // Deliberately reversed: a payload's key order must not reach the file.
          party: { kind: 'repeater', rows: [{ full_name: 'Bo' }] },
          questions: { kind: 'flat', values: { accessibility_needs: 'Step-free' } },
          registrant: { kind: 'flat', values: { contact_name: 'Ada', contact_email: 'a@x.test' } },
        }),
      ],
      META,
    );

    expect(headerIndex(table.headers, 'Full name')).toBeLessThan(
      headerIndex(table.headers, 'Seat 1 — Guest name'),
    );
    expect(headerIndex(table.headers, 'Seat 1 — Guest name')).toBeLessThan(
      headerIndex(table.headers, 'Accessibility needs'),
    );
  });

  it('gives a repeater a seat column even when every party was empty', () => {
    const schema = publicForm();
    const table = buildExportTable(
      [response(1, schema, { party: { kind: 'repeater', rows: [] } })],
      META,
    );
    expect(table.headers).toContain('Seat 1 — Guest name');
  });

  it('keeps columns from an older pinned schema rather than dropping the answers', () => {
    const older = publicForm();
    let newer = publicForm();
    const index = newer.blocks.length - 1;
    // The question was renamed and a second one added after response 1 was taken.
    newer = updateField(newer, index, 0, { label: 'Access requirements' });
    newer = addField(newer, index, 'Programme copy');

    const table = buildExportTable(
      [
        response(1, older, {
          questions: { kind: 'flat', values: { accessibility_needs: 'Step-free' } },
        }),
        response(2, newer, {
          questions: {
            kind: 'flat',
            values: { accessibility_needs: 'None', programme_copy: 'Yes' },
          },
        }),
      ],
      META,
    );

    // The newest schema sets the order and the wording...
    expect(table.headers).toContain('Access requirements');
    expect(table.headers).toContain('Programme copy');

    // ...and response 1's answer is still in the file, under the column its own
    // key maps to, rather than being silently dropped.
    const column = headerIndex(table.headers, 'Access requirements');
    expect(table.rows[0][column]).toBe('Step-free');
    expect(table.rows[1][column]).toBe('None');
  });

  it('appends a column for a question the newest schema no longer has', () => {
    // The interesting half of the same rule: a question deleted mid-round is
    // gone from the current form, but people answered it, and an export that
    // dropped the column would lose those answers with no trace.
    let older = addCustomBlock(blankFormSchema('FEEDBACK'), 'Questions');
    const index = older.blocks.length - 1;
    older = addField(older, index, 'Interval drink');

    const newer = addCustomBlock(blankFormSchema('FEEDBACK'), 'Questions');

    const table = buildExportTable(
      [
        response(1, older, {
          questions: { kind: 'flat', values: { interval_drink: 'Tea' } },
        }),
        response(2, newer, { questions: { kind: 'flat', values: {} } }),
      ],
      META,
    );

    const column = headerIndex(table.headers, 'Interval drink');
    expect(table.rows[0][column]).toBe('Tea');
    expect(table.rows[1][column]).toBe('');
  });
});

describe('one row per registration, party expanded across columns', () => {
  it('expands the widest party and leaves smaller ones blank', () => {
    const schema = publicForm();
    const table = buildExportTable(
      [
        response(1, schema, {
          party: { kind: 'repeater', rows: [{ full_name: 'Bo' }, { full_name: 'Cy' }] },
        }),
        response(2, schema, { party: { kind: 'repeater', rows: [{ full_name: 'Di' }] } }),
      ],
      META,
    );

    expect(table.rows).toHaveLength(2);

    const seat1 = headerIndex(table.headers, 'Seat 1 — Guest name');
    const seat2 = headerIndex(table.headers, 'Seat 2 — Guest name');
    expect(table.rows[0][seat1]).toBe('Bo');
    expect(table.rows[0][seat2]).toBe('Cy');
    expect(table.rows[1][seat1]).toBe('Di');
    // A party of one leaves seat 2 empty rather than shifting later columns.
    expect(table.rows[1][seat2]).toBe('');
  });

  it('writes one row per response, even when one supersedes another', () => {
    const schema = publicForm();
    const table = buildExportTable(
      [
        response(1, schema, { questions: { kind: 'flat', values: { accessibility_needs: 'A' } } }),
        response(2, schema, { questions: { kind: 'flat', values: { accessibility_needs: 'B' } } }),
      ],
      META,
    );
    expect(table.rows).toHaveLength(2);
  });
});

describe('a question that was never shown exports blank', () => {
  it('cannot be told apart from one that was shown and skipped', () => {
    let schema = addCustomBlock(blankFormSchema('FEEDBACK'), 'Questions');
    const index = schema.blocks.length - 1;
    schema = addField(schema, index, 'Came by car');
    schema = addField(schema, index, 'Parking needed');
    schema = updateField(schema, index, 1, {
      condition: { field: 'came_by_car', op: 'answered' },
    });

    const table = buildExportTable(
      [
        // Never shown: `validateAnswers` strips a hidden key, so it is absent.
        response(1, schema, { questions: { kind: 'flat', values: { came_by_car: '' } } }),
        // Shown and skipped: the key is present and empty.
        response(2, schema, {
          questions: { kind: 'flat', values: { came_by_car: 'Yes', parking_needed: '' } },
        }),
      ],
      META,
    );

    const column = headerIndex(table.headers, 'Parking needed');
    expect(table.rows[0][column]).toBe('');
    expect(table.rows[1][column]).toBe('');
    // §8.2.2: nothing downstream may depend on telling those apart.
    expect(table.rows[0][column]).toBe(table.rows[1][column]);
  });
});

describe('cells', () => {
  it('joins a multiselect and keeps a checkbox boolean', () => {
    let schema = addCustomBlock(blankFormSchema('FEEDBACK'), 'Questions');
    const index = schema.blocks.length - 1;
    schema = addField(schema, index, 'Which pieces');
    schema = addField(schema, index, 'Join the mailing list');
    schema = updateField(schema, index, 0, {
      type: 'multiselect',
      options: [
        { value: 'a', label: 'A' },
        { value: 'b', label: 'B' },
      ],
    });
    schema = updateField(schema, index, 1, { type: 'checkbox' });

    const table = buildExportTable(
      [
        response(1, schema, {
          questions: {
            kind: 'flat',
            values: { which_pieces: ['a', 'b'], join_the_mailing_list: true },
          },
        }),
      ],
      META,
    );

    expect(table.rows[0][headerIndex(table.headers, 'Which pieces')]).toBe('a, b');
    // Left a boolean so the shared export layer renders the same yes/no every
    // other table uses, rather than this module spelling it a second way.
    expect(table.rows[0][headerIndex(table.headers, 'Join the mailing list')]).toBe(true);
  });

  it('never emits two identical headers', () => {
    let schema = addCustomBlock(blankFormSchema('FEEDBACK'), 'First');
    const first = schema.blocks.length - 1;
    schema = addField(schema, first, 'Notes');
    schema = addCustomBlock(schema, 'Second');
    const second = schema.blocks.length - 1;
    schema = addField(schema, second, 'Notes');

    const table = buildExportTable([response(1, schema, {})], META);
    expect(new Set(table.headers).size).toBe(table.headers.length);
  });

  it('still exports what it can when a pinned schema no longer parses', () => {
    const schema = publicForm();
    const table = buildExportTable(
      [
        response(1, { blocks: [] } as unknown as FormSchema, { anything: { kind: 'flat', values: {} } }),
        response(2, schema, {
          questions: { kind: 'flat', values: { accessibility_needs: 'Step-free' } },
        }),
      ],
      META,
    );

    // The unreadable one still gets a row — its answers are real — and the
    // readable one still supplies the columns.
    expect(table.rows).toHaveLength(2);
    expect(table.rows[1][headerIndex(table.headers, 'Accessibility needs')]).toBe('Step-free');
  });

  it('keeps every row the same width as the header', () => {
    const schema = publicForm();
    const table = buildExportTable(
      [
        response(1, schema, { party: { kind: 'repeater', rows: [{ full_name: 'Bo' }] } }),
        response(2, schema, {}),
      ],
      META,
    );

    for (const row of table.rows) expect(row).toHaveLength(table.headers.length);
    expect(table.widths).toHaveLength(table.headers.length);
  });
});
