'use client';

import { useId } from 'react';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { CONDITION_OPS, type ConditionOp } from '@/lib/forms/conditions';
import type { FormField } from '@/lib/forms/schema';
import { opAllowed, type ConditionSource } from './operations';

/**
 * Show/hide rules on a custom field (spec/v2.md §8.2.2, decision 37).
 *
 * **The editor cannot express an illegal rule.** The source list is
 * `conditionSources` — custom fields, earlier, in the same scope — and the
 * operator list is filtered by the source's own type. A system field is never
 * offered as either side, because a rule that could hide the email question, or
 * a seat's name, would put the allocation path under something an admin
 * assembled in a UI and the failure would be silent: the form would simply not
 * ask.
 *
 * The contract refuses those schemas anyway. Offering them and then refusing
 * the save would teach an admin that the builder is unreliable, which is how
 * people end up working around a boundary rather than through it.
 *
 * A choice source offers its own options rather than a free-text box, which is
 * the one rule that catches the common editing accident: a condition typed
 * against a value the field does not offer is permanently false, and a
 * permanently false condition is a question the form silently never asks.
 */

const OP_LABEL: Record<ConditionOp, string> = {
  eq: 'is',
  ne: 'is not',
  in: 'is one of',
  contains: 'includes',
  answered: 'is answered',
  blank: 'is blank',
};

export function ConditionEditor({
  condition,
  sources,
  onChange,
}: {
  condition: FormField['condition'];
  sources: ConditionSource[];
  onChange: (next: FormField['condition'] | null) => void;
}) {
  const id = useId();

  if (sources.length === 0) {
    return (
      <FieldDescription>
        A rule reads an earlier question in the same section, and there is none yet.
        Add a question above this one — or, inside a repeating section, one in the same
        row — and a rule can read it.
      </FieldDescription>
    );
  }

  const source = sources.find((candidate) => candidate.key === condition?.field);
  const ops = CONDITION_OPS.filter((op) => !source || opAllowed(op, source.type));

  function setSource(key: string) {
    if (!key) return onChange(null);
    const next = sources.find((candidate) => candidate.key === key);
    if (!next) return onChange(null);
    // The operator and value are re-chosen with the source: an `is one of`
    // carried across to a checkbox, or a value carried across to a field that
    // does not offer it, is the permanently-false rule described above.
    const op: ConditionOp = next.type === 'multiselect' ? 'contains' : 'eq';
    onChange({ field: key, op, value: next.options?.[0]?.value ?? '' });
  }

  function setOp(op: ConditionOp) {
    if (!condition) return;
    if (op === 'answered' || op === 'blank') return onChange({ field: condition.field, op });
    if (op === 'in') {
      const current = condition.value;
      return onChange({
        field: condition.field,
        op,
        value: Array.isArray(current) ? current : current === undefined ? [] : [current as string],
      });
    }
    const current = Array.isArray(condition.value) ? condition.value[0] : condition.value;
    onChange({ field: condition.field, op, value: current ?? source?.options?.[0]?.value ?? '' });
  }

  const takesValue = condition && condition.op !== 'answered' && condition.op !== 'blank';

  return (
    <div className="flex flex-col gap-3">
      <Field>
        <FieldLabel htmlFor={`${id}-source`}>Show this only when</FieldLabel>
        <NativeSelect
          id={`${id}-source`}
          value={condition?.field ?? ''}
          onChange={(event) => setSource(event.target.value)}
        >
          <option value="">Always show it</option>
          {sources.map((candidate) => (
            <option key={candidate.key} value={candidate.key}>
              {candidate.label}
            </option>
          ))}
        </NativeSelect>
      </Field>

      {condition && source && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor={`${id}-op`}>Test</FieldLabel>
            <NativeSelect
              id={`${id}-op`}
              value={condition.op}
              onChange={(event) => setOp(event.target.value as ConditionOp)}
            >
              {ops.map((op) => (
                <option key={op} value={op}>
                  {OP_LABEL[op]}
                </option>
              ))}
            </NativeSelect>
          </Field>

          {takesValue && (
            <Field>
              <FieldLabel htmlFor={`${id}-value`}>Value</FieldLabel>
              <ConditionValue
                id={`${id}-value`}
                condition={condition}
                source={source}
                onChange={(value) => onChange({ ...condition, value })}
              />
            </Field>
          )}
        </div>
      )}

      {condition && source && (
        <FieldDescription>
          Hidden questions are never asked and export blank, the same as a question
          somebody skipped.
        </FieldDescription>
      )}
    </div>
  );
}

function ConditionValue({
  id,
  condition,
  source,
  onChange,
}: {
  id: string;
  condition: NonNullable<FormField['condition']>;
  source: ConditionSource;
  onChange: (value: string | string[]) => void;
}) {
  if (source.options) {
    if (condition.op === 'in') {
      const selected = new Set((Array.isArray(condition.value) ? condition.value : []).map(String));
      return (
        <div className="flex flex-col gap-1.5">
          {source.options.map((option) => (
            <label key={option.value} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="size-4 accent-primary"
                checked={selected.has(option.value)}
                onChange={(event) => {
                  const next = new Set(selected);
                  if (event.target.checked) next.add(option.value);
                  else next.delete(option.value);
                  onChange([...next]);
                }}
              />
              {option.label}
            </label>
          ))}
        </div>
      );
    }

    return (
      <NativeSelect
        id={id}
        value={String(condition.value ?? '')}
        onChange={(event) => onChange(event.target.value)}
      >
        {source.options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </NativeSelect>
    );
  }

  if (condition.op === 'in') {
    return (
      <Input
        id={id}
        value={(Array.isArray(condition.value) ? condition.value : []).join(', ')}
        placeholder="one, two, three"
        onChange={(event) =>
          onChange(
            event.target.value
              .split(',')
              .map((part) => part.trim())
              .filter(Boolean),
          )
        }
      />
    );
  }

  return (
    <Input
      id={id}
      type={source.type === 'number' ? 'number' : 'text'}
      value={String(condition.value ?? '')}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}
