'use client';

import { useMemo, useState } from 'react';
import { PlusIcon, XIcon } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { FieldGroup, FieldLegend, FieldSet } from '@/components/ui/field';
import { Separator } from '@/components/ui/separator';
import {
  emptyRow,
  fieldPathKey,
  type AnswerErrors,
  type BlockAnswer,
  type FormAnswers,
} from '@/lib/forms/answers';
import { visibleFieldKeys } from '@/lib/forms/conditions';
import type { FieldValue } from '@/lib/forms/field-types';
import { interpolateCopy, type CopyValues } from '@/lib/forms/copy';
import { blockFields, isRepeaterType, type FormBlock, type FormSchema } from '@/lib/forms/schema';
import { FormFieldControl } from './form-field';
import { RichText } from './rich-text';

/**
 * **The one generic renderer.** All three form kinds, driven from the JSON
 * (spec/surfaces.md §15.2: *"do not build two forms"*).
 *
 * Three consumers, which is exactly why it is built once, here, before any of
 * them start: `L`'s live preview, `M`'s public surfaces, and `M`'s edit screen.
 * Built three times it is three divergent renderers and three sets of
 * validation bugs — V1's `DataTable` argument, unchanged.
 *
 * **What it is not.** It does not submit, does not fetch, does not know what a
 * seat is and does not talk to the database. It draws a schema and reports
 * answers; the surface around it owns the form element, the action, the seat
 * indicator, and what any of it means. That boundary is what lets the same
 * component be a read-only preview in the admin console and a live form on a
 * stranger's phone.
 *
 * **Controlled, always.** The caller holds the answers — `M` needs them on the
 * server after a failed submit, and `L`'s preview needs to reset them when the
 * schema changes. {@link useFormAnswers} is the one-liner for a caller that has
 * no opinion.
 */

export type FormRendererProps = {
  /** Already parsed by `parseFormSchema`. The renderer assumes the contract holds. */
  schema: FormSchema;
  /**
   * Row caps per repeater block id, from `resolveRepeaterLimits`.
   *
   * A repeater with no entry here renders as unconfigured rather than
   * unlimited — the same refusal `limits.ts` makes, restated where it is
   * visible, because "unlimited" is the one reading that could oversell.
   */
  limits: Readonly<Record<string, number>>;
  /** Resolved `{{token}}` values, from `resolveFormCopy`. */
  copy: CopyValues;
  value: FormAnswers;
  onValueChange: (next: FormAnswers) => void;
  /** Server-side errors, keyed exactly as `validateAnswers` keys them. */
  errors?: AnswerErrors;
  /** `L`'s preview and a submitted-and-waiting form. Everything renders; nothing accepts input. */
  disabled?: boolean;
  /**
   * Report unresolved `{{tokens}}` — `L`'s preview shows these to the admin.
   *
   * Off by default: a stranger filling in a form cannot act on a typo in copy,
   * and telling them about it only advertises that something is broken.
   */
  showCopyWarnings?: boolean;
};

export function FormRenderer({
  schema,
  limits,
  copy,
  value,
  onValueChange,
  errors = {},
  disabled = false,
  showCopyWarnings = false,
}: FormRendererProps) {
  const setBlock = (blockId: string, next: BlockAnswer) =>
    onValueChange({ ...value, [blockId]: next });

  return (
    <div className="flex flex-col gap-10">
      {schema.blocks.map((block, index) => (
        <div key={block.id} className="flex flex-col gap-4">
          {index > 0 ? <Separator className="mb-2" /> : null}
          <BlockRenderer
            block={block}
            answer={value[block.id]}
            onChange={(next) => setBlock(block.id, next)}
            cap={limits[block.id]}
            copy={copy}
            errors={errors}
            disabled={disabled}
            showCopyWarnings={showCopyWarnings}
          />
        </div>
      ))}
    </div>
  );
}

type BlockProps = {
  block: FormBlock;
  answer: BlockAnswer | undefined;
  onChange: (next: BlockAnswer) => void;
  cap: number | undefined;
  copy: CopyValues;
  errors: AnswerErrors;
  disabled: boolean;
  showCopyWarnings: boolean;
};

function BlockRenderer(props: BlockProps) {
  const { block, copy, showCopyWarnings, errors } = props;
  const description = useMemo(
    () => (block.description_md ? interpolateCopy(block.description_md, copy) : null),
    [block.description_md, copy],
  );

  return (
    <FieldSet>
      <FieldLegend>{block.title}</FieldLegend>
      {description ? (
        <RichText markdown={description.text} className="text-sm text-muted-foreground" />
      ) : null}
      {showCopyWarnings && description && description.unknown.length > 0 ? (
        <Alert variant="destructive">
          <AlertTitle>This block&rsquo;s text uses a token that does not exist</AlertTitle>
          <AlertDescription>
            {description.unknown.map((token) => `{{${token}}}`).join(', ')} will render as nothing.
          </AlertDescription>
        </Alert>
      ) : null}

      {errors[block.id] ? (
        <Alert variant="destructive">
          <AlertDescription>{errors[block.id]}</AlertDescription>
        </Alert>
      ) : null}

      {isRepeaterType(block.type) ? <Repeater {...props} /> : <FlatBlock {...props} />}
    </FieldSet>
  );
}

function FlatBlock({ block, answer, onChange, errors, disabled }: BlockProps) {
  const values = answer?.kind === 'flat' ? answer.values : {};
  const fields = blockFields(block);
  const visible = visibleFieldKeys(fields, values);

  return (
    <FieldGroup>
      {fields
        .filter((field) => visible.has(field.key))
        .map((field) => (
          <FormFieldControl
            key={field.key}
            field={field}
            path={fieldPathKey(block.id, field.key)}
            value={values[field.key] ?? null}
            onChange={(next) => onChange({ kind: 'flat', values: { ...values, [field.key]: next } })}
            error={errors[fieldPathKey(block.id, field.key)]}
            disabled={disabled}
          />
        ))}
    </FieldGroup>
  );
}

/**
 * A repeater: one card per seat, an add control, and a count.
 *
 * **The cap is stated, not merely enforced.** "2 of 3 added" above a disabled
 * Add button answers the question the reader is about to ask, where a button
 * that silently stops working reads as a broken page.
 *
 * The cap is still only what the *form* believes. Seats are `claim_seats()`'s to
 * grant, inside a row lock, and a submit that loses that race gets the segment's
 * real state back (§8.3) — that reconciliation is `M`'s, and nothing here should
 * imply the number below is a reservation.
 */
function Repeater({ block, answer, onChange, cap, errors, disabled }: BlockProps) {
  const rows = answer?.kind === 'repeater' ? answer.rows : [];
  const fields = blockFields(block);

  if (cap === undefined) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Not configured yet</AlertTitle>
        <AlertDescription>
          Nobody has set how many seats may be added here, so this section cannot be filled in.
        </AlertDescription>
      </Alert>
    );
  }

  const setRows = (next: Record<string, FieldValue>[]) => onChange({ kind: 'repeater', rows: next });
  const full = rows.length >= cap;

  return (
    <div className="flex flex-col gap-4">
      {cap === 0 ? (
        <p className="text-sm text-muted-foreground">
          There are no seats to add in this section.
        </p>
      ) : null}

      {rows.map((row, index) => {
        const visible = visibleFieldKeys(fields, row);
        return (
          <div key={index} className="rounded-lg border border-border p-4">
            <div className="mb-3 flex items-center justify-between gap-2">
              <span className="text-sm font-medium">Seat {index + 1}</span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={disabled}
                onClick={() => setRows(rows.filter((_, i) => i !== index))}
              >
                <XIcon aria-hidden />
                Remove
              </Button>
            </div>
            <FieldGroup>
              {fields
                .filter((field) => visible.has(field.key))
                .map((field) => (
                  <FormFieldControl
                    key={field.key}
                    field={field}
                    path={fieldPathKey(block.id, field.key, index)}
                    value={row[field.key] ?? null}
                    onChange={(next) =>
                      setRows(rows.map((r, i) => (i === index ? { ...r, [field.key]: next } : r)))
                    }
                    error={errors[fieldPathKey(block.id, field.key, index)]}
                    disabled={disabled}
                  />
                ))}
            </FieldGroup>
          </div>
        );
      })}

      {cap > 0 ? (
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            variant="outline"
            className="h-11"
            disabled={disabled || full}
            onClick={() => setRows([...rows, emptyRow(fields)])}
          >
            <PlusIcon aria-hidden />
            {block.type === 'GUESTS_PARTY' ? 'Add a guest' : 'Add a seat'}
          </Button>
          <span className="text-sm text-muted-foreground" aria-live="polite">
            {rows.length} of {cap} added
          </span>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Answer state for a caller with no opinion about where it lives — `L`'s
 * preview, and a client-side `M` form before it posts. Spreads straight into the
 * renderer:
 *
 * ```tsx
 * <FormRenderer schema={schema} limits={limits} copy={copy}
 *               {...useFormAnswers(emptyAnswers(schema, limits))} />
 * ```
 *
 * **To reset it when the schema changes, give the renderer a React `key`** —
 * `key={schema_version}` in the builder's preview. That is how React discards
 * state, and it is more reliable than this hook trying to detect the change: a
 * preview that kept answers to questions the admin has since deleted would show
 * validation errors for fields that no longer exist.
 */
export function useFormAnswers(initial: FormAnswers): {
  value: FormAnswers;
  onValueChange: (next: FormAnswers) => void;
} {
  const [value, onValueChange] = useState(initial);
  return { value, onValueChange };
}
