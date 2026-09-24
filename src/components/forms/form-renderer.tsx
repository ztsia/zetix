'use client';

import { useMemo, useState } from 'react';
import { PlusIcon, XIcon } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
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
import {
  blockFields,
  flatScopeFields,
  isRepeaterType,
  type FormBlock,
  type FormSchema,
} from '@/lib/forms/schema';
import { FormFieldControl } from './form-field';
import { FormCard, SectionHeaderCard } from './form-surface';
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
 * **Drawn as Google Forms draws a form** — a card per section heading, a card
 * per question, a card per seat, all on the tinted form canvas — because that
 * is the form everyone answering this one has already filled in. The pieces
 * live in `form-surface.tsx`, which the builder's cards share.
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

  /**
   * Visibility for the flat scope, resolved **once for the whole form**.
   *
   * A condition may read any earlier custom field in the flat scope, including
   * one in an earlier block (`lib/forms/schema.ts`). Resolving this per block
   * would evaluate every cross-block condition against an empty source, so the
   * question would simply never be drawn — and `validateAnswers` resolves the
   * same scope the same way, because two implementations of "is this field
   * showing?" eventually disagree, and the way they disagree is a required
   * answer the form never asked for.
   */
  const flatVisible = useMemo(
    () => visibleFieldKeys(flatScopeFields(schema), flatAnswers(schema, value)),
    [schema, value],
  );

  const total = schema.blocks.length;

  return (
    <div className="flex flex-col gap-3">
      {schema.blocks.map((block, index) => (
        <BlockRenderer
          key={block.id}
          block={block}
          index={index}
          total={total}
          answer={value[block.id]}
          onChange={(next) => setBlock(block.id, next)}
          cap={limits[block.id]}
          copy={copy}
          errors={errors}
          disabled={disabled}
          showCopyWarnings={showCopyWarnings}
          flatVisible={flatVisible}
        />
      ))}
    </div>
  );
}

/**
 * Whether any question on the form is required — the header card's "*
 * Indicates required question" line is only true, and only drawn, when one is.
 */
export function hasRequiredQuestion(schema: FormSchema): boolean {
  return schema.blocks.some((block) => blockFields(block).some((field) => field.required));
}

/** Every flat block's answers as one map. Keys are unique across the scope by contract. */
function flatAnswers(schema: FormSchema, value: FormAnswers): Record<string, FieldValue> {
  const merged: Record<string, FieldValue> = {};
  for (const block of schema.blocks) {
    if (isRepeaterType(block.type)) continue;
    const answer = value[block.id];
    if (answer?.kind === 'flat') Object.assign(merged, answer.values);
  }
  return merged;
}

type BlockProps = {
  block: FormBlock;
  /** Where this block sits, for the "Section 2 of 3" tab. */
  index: number;
  total: number;
  answer: BlockAnswer | undefined;
  onChange: (next: BlockAnswer) => void;
  cap: number | undefined;
  copy: CopyValues;
  errors: AnswerErrors;
  disabled: boolean;
  showCopyWarnings: boolean;
  /** Resolved for the whole flat scope by {@link FormRenderer}, never per block. */
  flatVisible: ReadonlySet<string>;
};

function BlockRenderer(props: BlockProps) {
  const { block, index, total, copy, showCopyWarnings, errors } = props;
  const description = useMemo(
    () => (block.description_md ? interpolateCopy(block.description_md, copy) : null),
    [block.description_md, copy],
  );
  const headingId = `${block.id}-heading`;

  /**
   * A `section` named by its heading, so a screen reader can move between
   * sections the way a sighted reader moves between the cards.
   */
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <SectionHeaderCard index={index} total={total} title={<span id={headingId}>{block.title}</span>}>
        {description ? <RichText markdown={description.text} className="text-sm leading-6" /> : null}
        {showCopyWarnings && description && description.unknown.length > 0 ? (
          <Alert variant="destructive">
            <AlertTitle>This section&rsquo;s text uses a token that does not exist</AlertTitle>
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
      </SectionHeaderCard>

      {isRepeaterType(block.type) ? <Repeater {...props} /> : <FlatBlock {...props} />}
    </section>
  );
}

function FlatBlock({ block, answer, onChange, errors, disabled, flatVisible }: BlockProps) {
  const values = answer?.kind === 'flat' ? answer.values : {};
  const fields = blockFields(block);

  return (
    <>
      {fields
        .filter((field) => flatVisible.has(field.key))
        .map((field) => {
          const path = fieldPathKey(block.id, field.key);
          return (
            <FormCard key={field.key} invalid={Boolean(errors[path])}>
              <FormFieldControl
                field={field}
                path={path}
                value={values[field.key] ?? null}
                onChange={(next) =>
                  onChange({ kind: 'flat', values: { ...values, [field.key]: next } })
                }
                error={errors[path]}
                disabled={disabled}
              />
            </FormCard>
          );
        })}
    </>
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

  /**
   * The admin's own wording for the add control, which the builder offers and
   * this used to ignore — falling back to the old fixed words when a block
   * carries none.
   */
  const addLabel =
    ('add_label' in block ? block.add_label : undefined) ??
    (block.type === 'GUESTS_PARTY' ? 'Add a guest' : 'Add a seat');

  return (
    <>
      {cap === 0 ? (
        <FormCard className="text-muted-foreground text-sm">
          There are no seats to add in this section.
        </FormCard>
      ) : null}

      {rows.map((row, index) => {
        const visible = visibleFieldKeys(fields, row);
        const rowInvalid = fields.some(
          (field) => errors[fieldPathKey(block.id, field.key, index)] !== undefined,
        );
        /*
         * One card per seat, its questions stacked inside, divided by the same
         * hairline Google Forms draws between an item's parts. A seat is one
         * person, so its name and email belong in one card rather than one
         * card each — that is what keeps "Seat 2" legible as a unit when an
         * error lands in it.
         */
        return (
          <FormCard key={index} invalid={rowInvalid} className="flex flex-col gap-6">
            <div className="-mt-1 flex items-center justify-between gap-3">
              <h3 className="text-base font-medium">Seat {index + 1}</h3>
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
          </FormCard>
        );
      })}

      {cap > 0 ? (
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            variant="outline"
            className="bg-form-card h-10 rounded border-form-line"
            disabled={disabled || full}
            onClick={() => setRows([...rows, emptyRow(fields)])}
          >
            <PlusIcon aria-hidden />
            {addLabel}
          </Button>
          <span className="text-sm text-muted-foreground" aria-live="polite">
            {rows.length} of {cap} added
          </span>
        </div>
      ) : null}
    </>
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
