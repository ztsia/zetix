'use client';

import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Star } from 'lucide-react';
import { Textarea } from '@/components/ui/textarea';
import { isGridValue, type FieldValue, type GridValue } from '@/lib/forms/field-types';
import type { FormField } from '@/lib/forms/schema';
import { cn } from '@/lib/utils';
import { QuestionError, RequiredMark } from './form-surface';
import { RichText } from './rich-text';

/**
 * One question, in each of the fifteen types (spec/v2.md §8.2), drawn the way
 * Google Forms draws it.
 *
 * **Why that look.** Every round of this concert so far was answered on Google
 * Forms, so the reader already knows the grammar: the question in 16px with a
 * red asterisk, the help text small beneath it, a text answer as an underline
 * reading "Your answer", choices as a column of round or square marks in the
 * form's accent, a drop-down as an outlined "Choose" box. Borrowing it means
 * nobody meets an unfamiliar control between them and a seat.
 *
 * This renders the question's **contents** — title, help, control, error — and
 * not the card around it. The renderer draws one card per question on the page,
 * and a repeater seat stacks several questions inside one card, so the card is
 * the caller's.
 *
 * **Still sized for a phone** (spec/surfaces.md §15.2). Every text control stays
 * at least 40px tall, and `text-base` below `md` is what stops iOS zooming the
 * page on focus; nothing here may reduce that. Three choices depart from the
 * obvious component, each for the phone:
 *
 * - **`select` uses `NativeSelect`.** A native `<select>` opens the OS picker —
 *   a thumb-sized wheel on iOS, a full-screen list on Android — which beats a
 *   popover listbox on a small screen.
 * - **`date` and `time` use the native inputs**, for the same reason: the OS
 *   control against a popover sized for a mouse.
 * - **`multiselect` is a checkbox group**, as on Google Forms: every option is
 *   visible and each costs one tap.
 */

/**
 * The underline text field — Google Forms' "Your answer".
 *
 * Stated as a literal on every control rather than assembled at runtime:
 * Tailwind scans source text, so a class built in a template string never
 * reaches the stylesheet. `twMerge` in `cn` drops the `Input` defaults these
 * replace (the box border, the radius, the ring).
 */
const UNDERLINE =
  'h-10 rounded-none border-0 border-b border-form-line bg-transparent px-0 text-base shadow-none focus-visible:border-b-2 focus-visible:border-form-accent focus-visible:ring-0 aria-invalid:border-form-error aria-invalid:ring-0 disabled:bg-transparent md:text-sm dark:bg-transparent dark:disabled:bg-transparent';

/** A 20px radio in the accent, with the accent dot. */
const RADIO =
  'size-5 border-2 border-muted-foreground data-checked:border-form-accent data-checked:bg-transparent dark:data-checked:bg-transparent aria-invalid:aria-checked:border-form-accent [&_[data-slot=radio-group-indicator]]:size-5 [&_[data-slot=radio-group-indicator]_span]:size-2.5 [&_[data-slot=radio-group-indicator]_span]:bg-form-accent';

/** An 18px square in the accent, filled when ticked; the corner is the component's own. */
const CHECKBOX =
  'size-[18px] border-2 border-muted-foreground data-checked:border-form-accent data-checked:bg-form-accent data-checked:text-form-accent-foreground dark:data-checked:bg-form-accent aria-invalid:aria-checked:border-form-accent';

export type FormFieldControlProps = {
  field: FormField;
  /** `<blockId>.<key>` or `<blockId>.<row>.<key>` — unique on the page, and the error key. */
  path: string;
  value: FieldValue;
  onChange: (value: FieldValue) => void;
  error?: string;
  disabled?: boolean;
};

export function FormFieldControl(props: FormFieldControlProps) {
  const { field } = props;

  // A consent box reads as "label beside the box", not a question above it.
  if (field.type === 'checkbox') return <CheckboxField {...props} />;
  // Several controls answering one question need a legend, not a label that
  // points at one input.
  if (field.type === 'radio' || field.type === 'multiselect') {
    return <ChoiceGroupField {...props} />;
  }
  if (field.type === 'scale') return <ScaleField {...props} />;
  if (field.type === 'rating') return <RatingField {...props} />;
  if (field.type === 'grid_radio' || field.type === 'grid_checkbox') {
    return <GridField {...props} />;
  }

  const { path, error } = props;
  return (
    <div data-slot="field" data-invalid={error ? true : undefined} className="flex flex-col">
      <label htmlFor={path} className="text-base leading-6">
        {field.label}
        <RequiredMark required={field.required} />
      </label>
      <Help field={field} path={path} />
      <div className="mt-4">
        <Control {...props} invalid={Boolean(error)} />
      </div>
      {error ? <QuestionError>{error}</QuestionError> : null}
    </div>
  );
}

/**
 * The question's title and help, above a group of controls.
 *
 * A `legend`, so a screen reader announces the question on entering the group.
 */
function Legend({ field, path }: { field: FormField; path: string }) {
  return (
    <>
      <legend className="text-base leading-6">
        {field.label}
        <RequiredMark required={field.required} />
      </legend>
      <Help field={field} path={path} />
    </>
  );
}

function Control({
  field,
  path,
  value,
  onChange,
  disabled,
  invalid,
}: FormFieldControlProps & { invalid: boolean }) {
  /**
   * `placeholder` is deliberately not in here. It is not a `select` attribute,
   * and on that control the admin's placeholder labels the empty option
   * instead — so each branch takes it, or does not, on its own.
   */
  const shared = {
    id: path,
    disabled,
    'aria-invalid': invalid || undefined,
    'aria-required': field.required || undefined,
    'aria-describedby': field.help_md ? `${path}-help` : undefined,
  };

  switch (field.type) {
    case 'textarea':
      /**
       * Grows with what is typed, as Google Forms' paragraph answer does,
       * rather than opening as a tall empty box: `field-sizing-content` sizes
       * the element to its text, and `min-h-10` keeps an empty one the height
       * of a short answer.
       */
      return (
        <Textarea
          {...shared}
          className={cn(UNDERLINE, 'field-sizing-content min-h-10 resize-none py-2')}
          rows={1}
          placeholder={field.placeholder ?? 'Your answer'}
          value={asText(value)}
          onChange={(event) => onChange(event.target.value)}
        />
      );

    case 'select':
      return (
        <NativeSelect
          {...shared}
          className="w-full sm:w-fit sm:min-w-52 [&>select]:h-12 [&>select]:border-form-line [&>select]:pl-4 [&>select]:text-base md:[&>select]:text-sm"
          value={asText(value)}
          onChange={(event) => onChange(event.target.value)}
        >
          {/*
            An explicit empty option, always. Without one a `select` shows its
            first option as though it had been chosen, and an optional question
            silently acquires an answer nobody gave.
          */}
          <NativeSelectOption value="">{field.placeholder ?? 'Choose'}</NativeSelectOption>
          {(field.options ?? []).map((option) => (
            <NativeSelectOption key={option.value} value={option.value}>
              {option.label}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      );

    case 'number':
      return (
        <Input
          {...shared}
          className={cn(UNDERLINE, 'sm:w-1/2')}
          type="number"
          placeholder={field.placeholder ?? 'Your answer'}
          // A numeric keypad rather than the full keyboard.
          inputMode="numeric"
          value={asText(value)}
          onChange={(event) => onChange(event.target.value)}
        />
      );

    case 'date':
      /** The OS date control. It stores `YYYY-MM-DD`, which §8.2.3 promises. */
      return (
        <Input
          {...shared}
          className={cn(UNDERLINE, 'w-auto min-w-40')}
          type="date"
          value={asText(value)}
          onChange={(event) => onChange(event.target.value)}
        />
      );

    case 'time':
      /** The OS time control — a wheel on iOS, a dial on Android — storing `HH:MM`. */
      return (
        <Input
          {...shared}
          className={cn(UNDERLINE, 'w-auto min-w-32')}
          type="time"
          value={asText(value)}
          onChange={(event) => onChange(event.target.value)}
        />
      );

    default:
      return (
        <Input
          {...shared}
          className={cn(UNDERLINE, 'sm:w-1/2')}
          type={field.type === 'email' ? 'email' : field.type === 'tel' ? 'tel' : 'text'}
          placeholder={field.placeholder ?? 'Your answer'}
          // The keyboard and the autofill hint the phone can actually use.
          inputMode={field.type === 'email' ? 'email' : field.type === 'tel' ? 'tel' : undefined}
          autoComplete={autoCompleteFor(field)}
          value={asText(value)}
          onChange={(event) => onChange(event.target.value)}
        />
      );
  }
}

/**
 * `radio` and `multiselect` — a column of options under one legend, every one
 * visible, one tap each.
 */
function ChoiceGroupField({ field, path, value, onChange, error, disabled }: FormFieldControlProps) {
  const describedBy = field.help_md ? `${path}-help` : undefined;

  return (
    <fieldset
      data-slot="field-set"
      data-invalid={error ? true : undefined}
      className="flex min-w-0 flex-col"
    >
      <Legend field={field} path={path} />
      {field.type === 'radio' ? (
        <RadioGroup
          value={asText(value)}
          onValueChange={(next) => onChange(typeof next === 'string' ? next : '')}
          disabled={disabled}
          className="mt-3 gap-0"
          aria-required={field.required || undefined}
          aria-describedby={describedBy}
        >
          {(field.options ?? []).map((option) => (
            <Choice key={option.value} id={`${path}.${option.value}`} label={option.label}>
              <RadioGroupItem
                id={`${path}.${option.value}`}
                value={option.value}
                className={RADIO}
              />
            </Choice>
          ))}
        </RadioGroup>
      ) : (
        <div className="mt-3 flex flex-col" aria-describedby={describedBy}>
          {(field.options ?? []).map((option) => (
            <Choice key={option.value} id={`${path}.${option.value}`} label={option.label}>
              <Checkbox
                id={`${path}.${option.value}`}
                checked={selected(value).includes(option.value)}
                disabled={disabled}
                className={CHECKBOX}
                onCheckedChange={(next) => onChange(toggle(field, value, option.value, next === true))}
              />
            </Choice>
          ))}
        </div>
      )}
      {error ? <QuestionError>{error}</QuestionError> : null}
    </fieldset>
  );
}

/** One option row: the mark, then the words, the whole row a tap target. */
function Choice({ id, label, children }: { id: string; label: string; children: React.ReactNode }) {
  return (
    <label
      htmlFor={id}
      className="flex min-h-10 cursor-pointer items-center gap-3 py-1.5 text-sm leading-5 has-disabled:cursor-default"
    >
      {children}
      <span>{label}</span>
    </label>
  );
}

function selected(value: FieldValue): string[] {
  return Array.isArray(value) ? value : [];
}

/**
 * Rebuilt from the schema's option order rather than by appending, so the
 * stored array reads in the order the questions were asked however the reader
 * happened to tick them — which is what makes two responses comparable in an
 * export.
 */
function toggle(field: FormField, value: FieldValue, option: string, on: boolean): string[] {
  const chosen = selected(value);
  return (field.options ?? [])
    .map((o) => o.value)
    .filter((v) => (v === option ? on : chosen.includes(v)));
}

/** The numbers a scale offers, inclusive of both ends. */
function steps(field: FormField): number[] {
  const scale = field.scale ?? { min: 1, max: 5 };
  return Array.from({ length: scale.max - scale.min + 1 }, (_, i) => scale.min + i);
}

/**
 * `scale` — Google Forms' linear scale: the numbers across, a radio under each,
 * and the end labels either side of the row.
 *
 * **A real radio group, not a `Slider`.** A slider always shows a value, so an
 * untouched optional scale would read as answered, and a thumb hits one of five
 * targets far more reliably than a precise stop on a track.
 *
 * **It stands on end on a phone**, as Google Forms' does: eleven stops across a
 * 360px screen are too small to tap, and a column of them is not. From `sm` up
 * it lies flat. The end labels move with it — beside the row when flat, above
 * and below the column when upright — so each label stays next to the number
 * it names.
 */
function ScaleField({ field, path, value, onChange, error, disabled }: FormFieldControlProps) {
  const scale = field.scale ?? { min: 1, max: 5 };
  const chosen = typeof value === 'number' ? String(value) : asText(value);

  return (
    <fieldset
      data-slot="field-set"
      data-invalid={error ? true : undefined}
      className="flex min-w-0 flex-col"
    >
      <Legend field={field} path={path} />
      <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-center sm:gap-4">
        {scale.min_label ? (
          <span className="text-sm sm:max-w-32 sm:pb-2.5 sm:text-right">{scale.min_label}</span>
        ) : null}
        <RadioGroup
          value={chosen}
          onValueChange={(next) => onChange(next === '' ? null : Number(next))}
          disabled={disabled}
          className="flex w-auto flex-col gap-0 sm:flex-row sm:gap-1"
          aria-required={field.required || undefined}
          aria-describedby={field.help_md ? `${path}-help` : undefined}
        >
          {steps(field).map((step) => (
            <label
              key={step}
              htmlFor={`${path}.${step}`}
              className="flex min-h-11 cursor-pointer items-center gap-4 sm:min-w-12 sm:flex-col sm:gap-3 sm:py-1"
            >
              <span className="w-5 text-center text-sm tabular-nums sm:w-auto">{step}</span>
              <RadioGroupItem id={`${path}.${step}`} value={String(step)} className={RADIO} />
            </label>
          ))}
        </RadioGroup>
        {scale.max_label ? <span className="text-sm sm:max-w-32 sm:pb-2.5">{scale.max_label}</span> : null}
      </div>
      {error ? <QuestionError>{error}</QuestionError> : null}
    </fieldset>
  );
}

/**
 * `rating` — the same answer as a scale, drawn as a row of stars with their
 * numbers above, as Google Forms draws it.
 *
 * **Stars in a radio group's clothing.** Each star is a real radio so the row is
 * one tab stop and arrow keys move between values. Picking a star fills every
 * star up to it. Picking the chosen star again clears it — without that, an
 * optional rating becomes required the instant it is touched by accident.
 */
function RatingField({ field, path, value, onChange, error, disabled }: FormFieldControlProps) {
  const current = typeof value === 'number' ? value : 0;

  return (
    <fieldset
      data-slot="field-set"
      data-invalid={error ? true : undefined}
      className="flex min-w-0 flex-col"
    >
      <Legend field={field} path={path} />
      <RadioGroup
        value={current > 0 ? String(current) : ''}
        onValueChange={(next) => onChange(next === '' ? null : Number(next))}
        disabled={disabled}
        className="mt-4 flex flex-row flex-wrap justify-center gap-1 sm:gap-4"
        aria-required={field.required || undefined}
        aria-describedby={field.help_md ? `${path}-help` : undefined}
      >
        {steps(field).map((step) => (
          <label
            key={step}
            htmlFor={`${path}.${step}`}
            className="flex min-w-11 cursor-pointer flex-col items-center gap-2 p-1 has-disabled:cursor-default"
            onClick={(event) => {
              // Re-picking the current value clears it. The click has to be
              // intercepted, because the radio would otherwise re-select what
              // is already selected and fire no change at all.
              if (current === step) {
                event.preventDefault();
                onChange(null);
              }
            }}
          >
            <span className="text-sm tabular-nums" aria-hidden>
              {step}
            </span>
            <RadioGroupItem id={`${path}.${step}`} value={String(step)} className="sr-only" />
            <Star
              aria-hidden
              className={cn(
                'size-8 stroke-[1.5] transition-colors',
                step <= current ? 'fill-form-accent text-form-accent' : 'text-muted-foreground',
              )}
            />
            <span className="sr-only">
              {step} of {field.scale?.max ?? 5}
            </span>
          </label>
        ))}
      </RadioGroup>
      {error ? <QuestionError>{error}</QuestionError> : null}
    </fieldset>
  );
}

/**
 * `grid_radio` and `grid_checkbox` — Google Forms' grids: the column headings
 * across the top, then one tinted band per row with its label on the left.
 *
 * **A real `<table>`**, because that is what it is: a screen reader announces
 * the row and column header for the cell the cursor is in, which is the only
 * way the control makes sense without sight of the grid.
 *
 * **It scrolls sideways on a phone**, with the row label pinned, rather than
 * collapsing each row into its own stacked question — that would silently turn
 * one question into six.
 */
function GridField({ field, path, value, onChange, error, disabled }: FormFieldControlProps) {
  const multiple = field.type === 'grid_checkbox';
  const rows = field.rows ?? [];
  const columns = field.options ?? [];
  const answers: GridValue = isGridValue(value) ? value : {};

  function cell(row: string, column: string, on: boolean) {
    const next: GridValue = { ...answers };
    if (multiple) {
      const chosen = Array.isArray(next[row]) ? (next[row] as string[]) : [];
      // Rebuilt from the schema's column order, for the same reason `toggle`
      // does it for a multiselect: two responses stay comparable.
      const kept = columns
        .map((option) => option.value)
        .filter((v) => (v === column ? on : chosen.includes(v)));
      if (kept.length > 0) next[row] = kept;
      else delete next[row];
    } else if (on) {
      next[row] = column;
    } else {
      delete next[row];
    }
    onChange(next);
  }

  return (
    <fieldset
      data-slot="field-set"
      data-invalid={error ? true : undefined}
      className="flex min-w-0 flex-col"
    >
      <Legend field={field} path={path} />
      {/*
        Both axes stated. `overflow-x-auto` alone computes `overflow-y` to
        `auto` as well, and a grid that grew its own vertical scrollbar reads
        as a broken inner pane — measured in a real browser, so do not
        "simplify" this to one property.
      */}
      <div className="mt-4 overflow-x-auto overflow-y-hidden">
        <table className="w-full min-w-max border-separate border-spacing-y-1.5 text-sm">
          <thead>
            <tr>
              <td className="bg-form-card sticky left-0" />
              {columns.map((column) => (
                <th
                  key={column.value}
                  scope="col"
                  className="min-w-16 px-2 pb-1 text-center text-sm font-normal"
                >
                  {column.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.value} className="bg-muted">
                <th
                  scope="row"
                  className="bg-muted sticky left-0 max-w-40 rounded-l-lg py-3 pr-4 pl-3 text-left font-normal"
                >
                  {row.label}
                </th>
                {columns.map((column, index) => {
                  const id = `${path}.${row.value}.${column.value}`;
                  const on = multiple
                    ? Array.isArray(answers[row.value]) &&
                      (answers[row.value] as string[]).includes(column.value)
                    : answers[row.value] === column.value;
                  return (
                    <td
                      key={column.value}
                      className={cn(
                        'px-2 py-2 text-center',
                        index === columns.length - 1 && 'rounded-r-lg',
                      )}
                    >
                      {/*
                        The label is visually hidden rather than absent: the
                        table headers carry the meaning for a screen reader
                        following the grid, but a control reached out of that
                        context still has to say what it is.
                      */}
                      <label htmlFor={id} className="inline-flex cursor-pointer p-2">
                        <span className="sr-only">
                          {row.label}: {column.label}
                        </span>
                        {multiple ? (
                          <Checkbox
                            id={id}
                            checked={on}
                            disabled={disabled}
                            className={CHECKBOX}
                            onCheckedChange={(next) => cell(row.value, column.value, next === true)}
                          />
                        ) : (
                          <input
                            id={id}
                            type="radio"
                            name={`${path}.${row.value}`}
                            checked={on}
                            disabled={disabled}
                            onChange={() => cell(row.value, column.value, true)}
                            className="accent-form-accent size-5"
                          />
                        )}
                      </label>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {error ? <QuestionError>{error}</QuestionError> : null}
    </fieldset>
  );
}

/** A single consent box: the box, and the question beside it. */
function CheckboxField({ field, path, value, onChange, error, disabled }: FormFieldControlProps) {
  return (
    <div data-slot="field" data-invalid={error ? true : undefined} className="flex flex-col">
      <div className="flex items-start gap-3">
        <Checkbox
          id={path}
          checked={value === true}
          disabled={disabled}
          aria-required={field.required || undefined}
          aria-describedby={field.help_md ? `${path}-help` : undefined}
          onCheckedChange={(next) => onChange(next === true)}
          className={cn(CHECKBOX, 'mt-0.5')}
        />
        <div className="flex flex-col">
          <label htmlFor={path} className="cursor-pointer text-base leading-6">
            {field.label}
            <RequiredMark required={field.required} />
          </label>
          <Help field={field} path={path} />
        </div>
      </div>
      {error ? <QuestionError>{error}</QuestionError> : null}
    </div>
  );
}

function Help({ field, path }: { field: FormField; path?: string }) {
  if (!field.help_md) return null;
  return (
    <div
      id={path ? `${path}-help` : undefined}
      data-slot="field-description"
      className="text-muted-foreground mt-1 text-xs leading-[18px]"
    >
      <RichText markdown={field.help_md} />
    </div>
  );
}

/**
 * Autofill hints, for the system fields only.
 *
 * A custom question is whatever the admin made it, and guessing `name` for a
 * field labelled "Your teacher's name" would have the phone fill in the
 * reader's own. Guessing wrong is worse than not guessing.
 */
function autoCompleteFor(field: FormField): string | undefined {
  if (!field.system) return undefined;
  switch (field.key) {
    case 'contact_name':
    case 'full_name':
      return 'name';
    case 'contact_email':
    case 'email':
      return 'email';
    case 'contact_phone':
      return 'tel';
    default:
      return undefined;
  }
}

/** Every control is controlled, so a value is never `undefined` on the way in. */
function asText(value: FieldValue): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'true' : '';
  if (Array.isArray(value)) return value.join(',');
  return String(value);
}
