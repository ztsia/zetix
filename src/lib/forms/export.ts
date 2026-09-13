/**
 * Turning responses into a spreadsheet (spec/v2.md §8.5).
 *
 * **Columns come from the pinned schema, not from the responses.** That is the
 * rule the whole module is shaped around, and it is the counterintuitive one:
 * the obvious implementation walks the answers and collects the keys it finds,
 * which silently drops every question nobody answered and reorders the rest by
 * accident of submission. Anyone reconciling a sheet expects the admin's
 * question order and a column per question asked — including the empty ones,
 * which are themselves the finding.
 *
 * Three rules, from §8.5:
 *
 * 1. Columns from the pinned schema, in the admin's order.
 * 2. **One row per registration** for registration forms, with the party
 *    expanded into numbered seat columns. **One row per attendee** for feedback.
 * 3. **A conditional field that was never shown exports blank**, and nothing
 *    downstream may tell that apart from a question shown and skipped (§8.2.2).
 *    This needs no code: `validateAnswers` strips hidden keys, so the answer is
 *    simply absent and absent renders empty — the same cell a skipped question
 *    produces.
 *
 * Pure and database-free, so the interesting parts are testable without a
 * fixture: it takes pinned schemas and payloads and returns headers and cells.
 * `/api/export/xlsx` renders them — `F2` built it, and a second exporter is
 * exactly what `modules.md` §4 forbids.
 */

import type { ExportValue } from '@/lib/export';
import { blockFields, isRepeaterType, parseFormSchema, type FormBlock, type FormSchema } from './schema';

/** One block's answers, as `answers.ts` stores them. Re-stated to keep this module pure. */
type BlockPayload =
  | { kind: 'flat'; values: Record<string, unknown> }
  | { kind: 'repeater'; rows: Record<string, unknown>[] };

type Payload = Record<string, BlockPayload | undefined>;

export type ExportTable = {
  headers: string[];
  widths: (number | null)[];
  rows: ExportValue[][];
};

/** A response as the exporter needs it, whichever table it came from. */
export type ExportableResponse = {
  id: number;
  /** The schema this response was answered against — never the form's current one. */
  formSchema: unknown;
  /** `form_responses.raw`, or `feedback_responses.answers`. */
  payload: unknown;
  submittedAt: Date;
  /** Columns that describe the response rather than answer a question. */
  meta: Record<string, ExportValue>;
};

/**
 * A column, resolved against one response's payload.
 *
 * Seat columns carry their row index because a party is expanded across
 * columns, not down rows: one registration is one row (§8.5 rule 2), so seat 3's
 * name is a column of its own and a party of two leaves it blank.
 */
type ColumnSpec =
  | { kind: 'meta'; header: string; metaKey: string; width?: number }
  | { kind: 'flat'; header: string; blockId: string; fieldKey: string; width?: number }
  | {
      kind: 'seat';
      header: string;
      blockId: string;
      rowIndex: number;
      fieldKey: string;
      width?: number;
    };

/**
 * The schemas actually present in an export, newest first.
 *
 * Responses pin the schema they were answered against (§8.2.4), so a form
 * edited mid-round produces an export spanning versions. The newest pinned
 * schema sets the column order — it is the form as it stands, and the order the
 * admin last chose — and anything only an older one had is appended rather than
 * dropped. Dropping it would lose answers people actually gave; interleaving it
 * would invent an order no admin ever saw.
 */
function schemasNewestFirst(responses: readonly ExportableResponse[]): FormSchema[] {
  const sorted = [...responses].sort(
    (a, b) => b.submittedAt.getTime() - a.submittedAt.getTime() || b.id - a.id,
  );
  const schemas: FormSchema[] = [];
  for (const response of sorted) {
    const parsed = parseFormSchema(response.formSchema);
    // A pinned schema that no longer parses is not a reason to fail the whole
    // download: its answers are still real, and the columns the other responses
    // supply still describe most of them.
    if (parsed.ok) schemas.push(parsed.schema);
  }
  return schemas;
}

/** How many rows the widest party in this export used, per repeater block. */
function seatCounts(responses: readonly ExportableResponse[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const response of responses) {
    const payload = asPayload(response.payload);
    for (const [blockId, block] of Object.entries(payload)) {
      if (block?.kind !== 'repeater') continue;
      counts.set(blockId, Math.max(counts.get(blockId) ?? 0, block.rows.length));
    }
  }
  return counts;
}

/**
 * A header that survives being read out of context, and stays unique.
 *
 * Field labels are the admin's words and nothing stops two blocks using the
 * same one — "Name" under both "Your details" and "Dietary requirements" is an
 * ordinary thing to write. A spreadsheet with two identical headers is one
 * nobody can reconcile, so a collision takes its block's title; a second
 * collision takes the field key, which the contract guarantees is unique within
 * its scope.
 */
function uniqueHeader(used: Set<string>, label: string, blockTitle: string, key: string): string {
  for (const candidate of [label, `${blockTitle} — ${label}`, `${blockTitle} — ${label} (${key})`]) {
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
  let n = 2;
  while (used.has(`${label} (${n})`)) n += 1;
  const fallback = `${label} (${n})`;
  used.add(fallback);
  return fallback;
}

function columnsForBlock(
  block: FormBlock,
  seats: number,
  used: Set<string>,
  seen: Set<string>,
): ColumnSpec[] {
  const specs: ColumnSpec[] = [];

  if (isRepeaterType(block.type)) {
    // At least one seat, even where nobody added a guest: the question was
    // asked, and rule 1 says an unanswered question still gets its column.
    for (let index = 0; index < Math.max(1, seats); index += 1) {
      for (const field of blockFields(block)) {
        const id = `seat:${block.id}:${index}:${field.key}`;
        if (seen.has(id)) continue;
        seen.add(id);
        specs.push({
          kind: 'seat',
          header: uniqueHeader(
            used,
            `Seat ${index + 1} — ${field.label}`,
            block.title,
            field.key,
          ),
          blockId: block.id,
          rowIndex: index,
          fieldKey: field.key,
          width: 24,
        });
      }
    }
    return specs;
  }

  for (const field of blockFields(block)) {
    const id = `flat:${block.id}:${field.key}`;
    if (seen.has(id)) continue;
    seen.add(id);
    specs.push({
      kind: 'flat',
      header: uniqueHeader(used, field.label, block.title, field.key),
      blockId: block.id,
      fieldKey: field.key,
      width: field.type === 'textarea' ? 40 : 24,
    });
  }

  return specs;
}

function answerColumns(
  responses: readonly ExportableResponse[],
  used: Set<string>,
  currentSchema?: FormSchema,
): ColumnSpec[] {
  const pinned = schemasNewestFirst(responses);
  const schemas = pinned.length > 0 ? pinned : currentSchema ? [currentSchema] : [];
  const seats = seatCounts(responses);
  const seen = new Set<string>();
  const specs: ColumnSpec[] = [];

  for (const schema of schemas) {
    for (const block of schema.blocks) {
      specs.push(...columnsForBlock(block, seats.get(block.id) ?? 0, used, seen));
    }
  }

  return specs;
}

function asPayload(value: unknown): Payload {
  if (value === null || typeof value !== 'object') return {};
  return value as Payload;
}

/**
 * One answer as a spreadsheet cell.
 *
 * A `multiselect` joins with `, ` rather than exporting an array — a cell holds
 * one value, and the alternative is `[object Object]`. A `checkbox` stays a
 * boolean so the export layer renders it as the same yes/no every other table
 * uses, rather than this module inventing a second spelling.
 */
function toCell(value: unknown): ExportValue {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.join(', ');
  if (typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
    return value;
  }
  return String(value);
}

function readCell(spec: ColumnSpec, response: ExportableResponse): ExportValue {
  if (spec.kind === 'meta') return response.meta[spec.metaKey] ?? '';

  const block = asPayload(response.payload)[spec.blockId];
  if (!block) return '';

  if (spec.kind === 'flat') {
    return block.kind === 'flat' ? toCell(block.values[spec.fieldKey]) : '';
  }

  if (block.kind !== 'repeater') return '';
  const row = block.rows[spec.rowIndex];
  return row ? toCell(row[spec.fieldKey]) : '';
}

/**
 * The whole table: the response's own columns first, then one per question.
 *
 * `meta` is declared by the caller rather than fixed here, because a
 * registration response and a feedback response describe themselves with
 * different facts — an edit chain on one, an attendee and a show on the other —
 * while the answer half is identical for both. That split is why one exporter
 * serves all three form kinds.
 */
export function buildExportTable(
  responses: readonly ExportableResponse[],
  metaColumns: readonly { header: string; key: string; width?: number }[],
  /**
   * The form's schema as it stands now, used **only when no response has
   * pinned one yet**.
   *
   * An export of an open form nobody has answered should still describe the
   * form: rule 1 says a question nobody answered gets a column, and with zero
   * responses that is every question. Without this the file is meta columns
   * and nothing else, which tells a reader nothing about what was asked.
   *
   * It is a fallback and never an override — the moment one response exists,
   * its pinned schema is what the columns come from, because a form edited
   * after the fact must not reshape a download of answers already given
   * (§8.2.4).
   */
  currentSchema?: FormSchema,
): ExportTable {
  const used = new Set<string>();
  const specs: ColumnSpec[] = [
    ...metaColumns.map(
      (column): ColumnSpec => ({
        kind: 'meta',
        header: uniqueHeader(used, column.header, 'Response', column.key),
        metaKey: column.key,
        width: column.width,
      }),
    ),
    ...answerColumns(responses, used, currentSchema),
  ];

  return {
    headers: specs.map((spec) => spec.header),
    widths: specs.map((spec) => spec.width ?? null),
    rows: responses.map((response) => specs.map((spec) => readCell(spec, response))),
  };
}
