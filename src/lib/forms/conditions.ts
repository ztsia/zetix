/**
 * Show/hide conditions on custom fields (spec/v2.md §8.2.2, decision 37).
 *
 * **Custom-to-custom only, in both directions.** A condition may only read an
 * earlier custom field and may only target a custom field. A system field is
 * never a condition's source and never its target — and a schema that tries is
 * a **schema error**, refused in `schema.ts`, not a runtime no-op.
 *
 * The asymmetry matters because the failure mode of leniency is silent: a rule
 * that could hide the email question, or a seat's name, would put the allocation
 * path under the control of something an admin assembled in a UI, and the form
 * would simply stop asking. Nobody finds out until a party reaches a door with
 * nothing.
 *
 * Evaluation is pure and shared: the renderer decides what to draw with it, and
 * `answers.ts` decides what to require with it. Two implementations of "is this
 * field showing?" would eventually disagree, and the way they would disagree is
 * a required answer the form never asked for.
 */

import { isBlank, type FieldValue } from './field-types';

/**
 * The operator set, kept deliberately small.
 *
 * Each one is unambiguous against every field type, which is what lets
 * `schema.ts` reject a nonsensical pairing (`contains` against a text field, an
 * `in` list against a checkbox) at save time rather than at render time.
 */
export const CONDITION_OPS = ['eq', 'ne', 'in', 'contains', 'answered', 'blank'] as const;

export type ConditionOp = (typeof CONDITION_OPS)[number];

/** Operators that take no `value` — they ask about presence, not content. */
export const PRESENCE_OPS: readonly ConditionOp[] = ['answered', 'blank'];

export type Condition = {
  /** The key of an earlier custom field **in the same scope** — see `schema.ts`. */
  field: string;
  op: ConditionOp;
  /** Absent for `answered` and `blank`; an array for `in`; a scalar otherwise. */
  value?: string | number | boolean | (string | number)[];
};

/**
 * Whether a field carrying `condition` should be shown, given the answers in
 * its own scope.
 *
 * **A missing source answer is not an error.** The source is guaranteed by
 * `schema.ts` to exist and to appear earlier, so "not answered yet" is the
 * normal state on first render, and it evaluates as blank.
 */
export function conditionHolds(
  condition: Condition,
  scopeAnswers: Readonly<Record<string, FieldValue | undefined>>,
): boolean {
  const answer = scopeAnswers[condition.field];

  switch (condition.op) {
    case 'answered':
      return !isBlank(answer);
    case 'blank':
      return isBlank(answer);
    case 'eq':
      return sameScalar(answer, condition.value);
    case 'ne':
      return !sameScalar(answer, condition.value);
    case 'in': {
      const list = Array.isArray(condition.value) ? condition.value : [];
      return list.some((candidate) => sameScalar(answer, candidate));
    }
    case 'contains': {
      // The source is a `multiselect`, which `schema.ts` guarantees.
      if (!Array.isArray(answer)) return false;
      return answer.some((entry) => sameScalar(entry, condition.value));
    }
  }
}

/**
 * Scalar comparison across the JSON boundary.
 *
 * A `number` field's answer arrives from an `<input>` as a string on the way in
 * and as a number on the way back out of `form_responses.raw`, and a condition
 * authored against `3` must not stop matching because the answer is `"3"`.
 * Comparing the string forms is the one rule that behaves the same in the
 * browser, in submit validation and against a pinned schema read back years
 * later.
 */
function sameScalar(a: unknown, b: unknown): boolean {
  if (a === null || a === undefined || Array.isArray(a)) return false;
  if (b === null || b === undefined || Array.isArray(b)) return false;
  return String(a) === String(b);
}

/**
 * Every field key that is visible in one scope, walking the fields in order.
 *
 * Order is load-bearing: a condition may only read an **earlier** field, so a
 * field hidden by its own condition can never influence a field before it, and
 * one pass is enough. A field whose source is itself hidden is hidden too —
 * `visible` only ever carries answers for fields that are actually showing, so
 * a hidden source reads as blank to everything downstream. That is the
 * behaviour §8.2.2 asks for: "a question that was never shown and a question
 * that was shown and skipped are both empty."
 */
export function visibleFieldKeys(
  fields: readonly { key: string; condition?: Condition }[],
  scopeAnswers: Readonly<Record<string, FieldValue | undefined>>,
): Set<string> {
  const visible = new Set<string>();
  const visibleAnswers: Record<string, FieldValue | undefined> = {};

  for (const field of fields) {
    if (field.condition && !conditionHolds(field.condition, visibleAnswers)) continue;
    visible.add(field.key);
    visibleAnswers[field.key] = scopeAnswers[field.key];
  }

  return visible;
}
