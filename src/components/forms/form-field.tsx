'use client';

import { Checkbox } from '@/components/ui/checkbox';
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Star } from 'lucide-react';
import { Textarea } from '@/components/ui/textarea';
import { isGridValue, type FieldValue, type GridValue } from '@/lib/forms/field-types';
import type { FormField } from '@/lib/forms/schema';
import { RichText } from './rich-text';

/**
 * One field, in each of the fifteen types (spec/v2.md §8.2).
 *
 * **Sized for the registration surface**, which is responsive and mostly read on
 * a phone (spec/surfaces.md §15.2). The design system's default control is `h-8`
 * — right for the admin console's dense tables, well under a comfortable touch
 * target here — so every control on this surface is `h-11`. `Input` already
 * carries `text-base` below `md`, which is what stops iOS zooming the page on
 * focus; nothing here may reduce that.
 *
 * Three choices depart from the obvious component, each for the phone:
 *
 * - **`select` uses `NativeSelect`, not `Select`.** A native `<select>` opens
 *   the OS picker — a thumb-sized wheel on iOS, a full-screen list on Android —
 *   which beats a popover listbox on a small screen, and it is already the
 *   project's convention in every admin dialog.
 * - **`date` uses `<input type="date">`, not `DatePicker`.** Same argument: the
 *   OS date control against a popover calendar sized for a mouse. The admin
 *   console keeps `DatePicker`, where the pointer is a pointer.
 * - **`multiselect` is a checkbox group, not a `Combobox`.** Option lists here
 *   are admin-authored and short; showing all of them costs one tap per choice
 *   and no popover, and a popover inside a repeater row on a phone is a
 *   scrolling trap.
 */

/**
 * Stated as a literal on every control rather than shared through a constant:
 * Tailwind scans source text, so a class assembled at runtime is a class that
 * never reaches the stylesheet.
 */
const CONTROL = 'h-11 text-base md:text-sm';

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
  const { field, path, error } = props;
  const invalid = Boolean(error);

  // A checkbox reads as "label beside the box", not "label above it", and a
  // radio group needs a legend rather than a label pointing at one input.
  if (field.type === 'checkbox') return <CheckboxField {...props} />;
  // Both render several controls under one question, so both need a legend
  // rather than a label pointing at one input.
  if (field.type === 'radio' || field.type === 'multiselect') {
    return <ChoiceGroupField {...props} />;
  }
  // Same again: a row of numbers, a row of stars, and a grid are each several
  // controls answering one question.
  if (field.type === 'scale') return <ScaleField {...props} />;
  if (field.type === 'rating') return <RatingField {...props} />;
  if (field.type === 'grid_radio' || field.type === 'grid_checkbox') {
    return <GridField {...props} />;
  }

  return (
    <Field data-invalid={invalid || undefined}>
      <FieldLabel htmlFor={path}>
        {field.label}
        <RequiredMark required={field.required} />
      </FieldLabel>
      <Control {...props} invalid={invalid} />
      <Help field={field} path={path} />
      {error ? <FieldError>{error}</FieldError> : null}
    </Field>
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
    'aria-describedby': field.help_md ? `${path}-help` : undefined,
  };

  switch (field.type) {
    case 'textarea':
      return (
        <Textarea
          {...shared}
          className="min-h-24 text-base md:text-sm"
          rows={4}
          placeholder={field.placeholder}
          value={asText(value)}
          onChange={(event) => onChange(event.target.value)}
        />
      );

    case 'select':
      return (
        <NativeSelect
          {...shared}
          className="w-full [&>select]:h-11 [&>select]:text-base md:[&>select]:text-sm"
          value={asText(value)}
          onChange={(event) => onChange(event.target.value)}
        >
          {/*
            An explicit empty option, always. Without one a `select` shows its
            first option as though it had been chosen, and an optional question
            silently acquires an answer nobody gave.
          */}
          <NativeSelectOption value="">
            {field.placeholder ?? 'Choose one…'}
          </NativeSelectOption>
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
          className={CONTROL}
          type="number"
          placeholder={field.placeholder}
          // A numeric keypad rather than the full keyboard, on a field that
          // takes digits.
          inputMode="numeric"
          value={asText(value)}
          onChange={(event) => onChange(event.target.value)}
        />
      );

    case 'date':
      return (
        <Input
          {...shared}
          className={CONTROL}
          type="date"
          value={asText(value)}
          onChange={(event) => onChange(event.target.value)}
        />
      );

    case 'time':
      /**
       * Same argument as `date`: the OS time control — a wheel on iOS, a clock
       * dial on Android — against a popover built for a pointer. It stores and
       * reads `HH:MM`, which is what §8.2.3 promises the raw payload holds.
       */
      return (
        <Input
          {...shared}
          className={CONTROL}
          type="time"
          value={asText(value)}
          onChange={(event) => onChange(event.target.value)}
        />
      );

    default:
      return (
        <Input
          {...shared}
          className={CONTROL}
          type={field.type === 'email' ? 'email' : field.type === 'tel' ? 'tel' : 'text'}
          placeholder={field.placeholder}
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
 * `radio` and `multiselect` — one question, several controls, one legend.
 *
 * Both render every option inline rather than behind a popover: the lists are
 * admin-authored and short, and on a phone a visible list costs one tap per
 * choice where a popover costs two and hides the rest of the question.
 */
function ChoiceGroupField({ field, path, value, onChange, error, disabled }: FormFieldControlProps) {
  return (
    <FieldSet data-invalid={error ? true : undefined}>
      <FieldLegend variant="label">
        {field.label}
        <RequiredMark required={field.required} />
      </FieldLegend>
      <Help field={field} path={path} />
      {field.type === 'radio' ? (
        <RadioGroup
          value={asText(value)}
          onValueChange={(next) => onChange(typeof next === 'string' ? next : '')}
          disabled={disabled}
          className="gap-3 pt-1"
          aria-describedby={field.help_md ? `${path}-help` : undefined}
        >
          {(field.options ?? []).map((option) => (
            <Choice
              key={option.value}
              id={`${path}.${option.value}`}
              label={option.label}
              control={<RadioGroupItem id={`${path}.${option.value}`} value={option.value} />}
            />
          ))}
        </RadioGroup>
      ) : (
        <div className="flex flex-col gap-3 pt-1">
          {(field.options ?? []).map((option) => (
            <Choice
              key={option.value}
              id={`${path}.${option.value}`}
              label={option.label}
              control={
                <Checkbox
                  id={`${path}.${option.value}`}
                  checked={selected(value).includes(option.value)}
                  disabled={disabled}
                  onCheckedChange={(next) => onChange(toggle(field, value, option.value, next === true))}
                />
              }
            />
          ))}
        </div>
      )}
      {error ? <FieldError>{error}</FieldError> : null}
    </FieldSet>
  );
}

function Choice({ id, label, control }: { id: string; label: string; control: React.ReactNode }) {
  return (
    <FieldLabel htmlFor={id} className="flex items-center gap-3 font-normal">
      {control}
      <span>{label}</span>
    </FieldLabel>
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
 * `scale` — a row of numbered radios with optional labels under the ends.
 *
 * **A real radio group, not a `Slider`.** A slider always shows a value, so an
 * untouched optional scale would read as answered — the same trap the `select`
 * branch's explicit empty option exists to avoid — and it is far harder to hit
 * a precise stop with a thumb than to tap one of five targets.
 *
 * The row scrolls rather than wraps: eleven stops at the widest setting will not
 * fit a narrow phone, and a scale that wrapped onto two lines would read as two
 * questions.
 */
function ScaleField({ field, path, value, onChange, error, disabled }: FormFieldControlProps) {
  const scale = field.scale ?? { min: 1, max: 5 };
  const chosen = typeof value === 'number' ? String(value) : asText(value);

  return (
    <FieldSet data-invalid={error ? true : undefined}>
      <FieldLegend variant="label">
        {field.label}
        <RequiredMark required={field.required} />
      </FieldLegend>
      <Help field={field} path={path} />
      {/*
        **The scroll lives on a wrapper, not on the group.**

        `overflow-x-auto` on its own is not a one-axis rule: CSS computes
        `overflow-y` from `visible` to `auto` whenever the other axis is not
        `visible`, so putting it straight on the radio group made the row a
        two-axis scroll container and it rendered as a scrollable inner pane
        with its own vertical bar.

        So both axes are stated: sideways scrolls, vertical is clipped and can
        never grow a bar of its own. `py-2`/`-mx-1`+`px-1` then give the focus
        ring more room than it needs inside that box, so clipping the vertical
        axis costs nothing visible.

        `w-max min-w-full` is what keeps the bar away in the common case: the
        row is as wide as its content but never narrower than the wrapper, so
        five stops spread across the width with no scrolling, and eleven on a
        narrow phone scroll rather than shrinking under a thumb.
      */}
      <div className="-mx-1 overflow-x-auto overflow-y-hidden px-1 py-2">
        <RadioGroup
          value={chosen}
          onValueChange={(next) => onChange(next === '' ? null : Number(next))}
          disabled={disabled}
          className="flex w-max min-w-full flex-row justify-between gap-2"
          aria-describedby={field.help_md ? `${path}-help` : undefined}
        >
          {steps(field).map((step) => (
            <FieldLabel
              key={step}
              htmlFor={`${path}.${step}`}
              className="flex min-w-11 shrink-0 flex-col items-center gap-2 font-normal"
            >
              <span className="text-sm tabular-nums">{step}</span>
              <RadioGroupItem id={`${path}.${step}`} value={String(step)} />
            </FieldLabel>
          ))}
        </RadioGroup>
      </div>
      {scale.min_label || scale.max_label ? (
        <div className="flex justify-between gap-4 text-xs text-muted-foreground">
          <span>{scale.min_label}</span>
          <span className="text-right">{scale.max_label}</span>
        </div>
      ) : null}
      {error ? <FieldError>{error}</FieldError> : null}
    </FieldSet>
  );
}

/**
 * `rating` — the same answer as a scale, drawn as stars.
 *
 * **Buttons in a radio group's clothing.** Each star is a real radio input so
 * the whole row is one tab stop and arrow keys move between values; the star is
 * the label. Hover and selection both fill up to the star under the pointer,
 * which is the behaviour everyone already expects from this control.
 *
 * A chosen rating can be cleared by picking it again — without that, an
 * optional rating becomes required the instant it is touched by accident.
 */
function RatingField({ field, path, value, onChange, error, disabled }: FormFieldControlProps) {
  const current = typeof value === 'number' ? value : 0;

  return (
    <FieldSet data-invalid={error ? true : undefined}>
      <FieldLegend variant="label">
        {field.label}
        <RequiredMark required={field.required} />
      </FieldLegend>
      <Help field={field} path={path} />
      <RadioGroup
        value={current > 0 ? String(current) : ''}
        onValueChange={(next) => onChange(next === '' ? null : Number(next))}
        disabled={disabled}
        className="group/rating flex flex-row gap-1 pt-1"
        aria-describedby={field.help_md ? `${path}-help` : undefined}
      >
        {steps(field).map((step) => (
          <FieldLabel
            key={step}
            htmlFor={`${path}.${step}`}
            className="cursor-pointer p-1 font-normal"
            title={`${step}`}
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
            <RadioGroupItem id={`${path}.${step}`} value={String(step)} className="sr-only" />
            <Star
              aria-hidden
              className={
                step <= current
                  ? 'size-7 fill-amber-400 text-amber-400 transition-colors'
                  : 'size-7 text-muted-foreground/40 transition-colors'
              }
            />
            <span className="sr-only">
              {step} of {field.scale?.max ?? 5}
            </span>
          </FieldLabel>
        ))}
      </RadioGroup>
      {error ? <FieldError>{error}</FieldError> : null}
    </FieldSet>
  );
}

/**
 * `grid_radio` and `grid_checkbox` — one question, a control per cell.
 *
 * **A real `<table>`**, because that is what it is: screen readers announce the
 * row and column header for the cell the cursor is in, which is the only way
 * the control makes sense without sight of the grid. Hand-built `div`s would
 * lose that, and a grid is precisely the type where losing it matters most.
 *
 * **It scrolls sideways on a phone**, with the row label pinned. Four columns
 * of touch targets do not fit a narrow screen, and the alternative — collapsing
 * each row into its own stacked question — silently turns one question into
 * six, which is not what the admin built.
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
      // Rebuilt from the schema's column order, for the same reason
      // `toggle` does it for a multiselect: two responses stay comparable.
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
    <FieldSet data-invalid={error ? true : undefined}>
      <FieldLegend variant="label">
        {field.label}
        <RequiredMark required={field.required} />
      </FieldLegend>
      <Help field={field} path={path} />
      {/* Both axes stated, for the same reason as the scale above:
          `overflow-x-auto` turns the vertical axis on too, and a grid that
          grew its own vertical scrollbar would read as a broken inner pane. */}
      <div className="-mx-1 overflow-x-auto overflow-y-hidden px-1 py-2">
        <table className="w-full min-w-max border-collapse text-sm">
          <thead>
            <tr>
              <td className="sticky left-0 bg-background" />
              {columns.map((column) => (
                <th
                  key={column.value}
                  scope="col"
                  className="px-3 pb-2 text-center text-xs font-normal text-muted-foreground"
                >
                  {column.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.value} className="border-t">
                <th
                  scope="row"
                  className="sticky left-0 bg-background py-3 pr-4 text-left font-normal"
                >
                  {row.label}
                </th>
                {columns.map((column) => {
                  const id = `${path}.${row.value}.${column.value}`;
                  const on = multiple
                    ? Array.isArray(answers[row.value]) &&
                      (answers[row.value] as string[]).includes(column.value)
                    : answers[row.value] === column.value;
                  return (
                    <td key={column.value} className="px-3 py-3 text-center">
                      {/*
                        The label is visually hidden rather than absent: the
                        table headers carry the meaning for a screen reader
                        following the grid, but a control reached out of that
                        context still has to say what it is.
                      */}
                      <label htmlFor={id} className="inline-flex cursor-pointer p-1">
                        <span className="sr-only">
                          {row.label}: {column.label}
                        </span>
                        {multiple ? (
                          <Checkbox
                            id={id}
                            checked={on}
                            disabled={disabled}
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
                            className="size-4 accent-primary"
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
      {error ? <FieldError>{error}</FieldError> : null}
    </FieldSet>
  );
}

function CheckboxField({ field, path, value, onChange, error, disabled }: FormFieldControlProps) {
  return (
    <Field orientation="horizontal" data-invalid={error ? true : undefined} className="items-start">
      <Checkbox
        id={path}
        checked={value === true}
        disabled={disabled}
        onCheckedChange={(next) => onChange(next === true)}
        className="mt-1"
      />
      <FieldContent>
        <FieldLabel htmlFor={path} className="font-normal">
          {field.label}
          <RequiredMark required={field.required} />
        </FieldLabel>
        <Help field={field} path={path} />
        {error ? <FieldError>{error}</FieldError> : null}
      </FieldContent>
    </Field>
  );
}

function Help({ field, path }: { field: FormField; path?: string }) {
  if (!field.help_md) return null;
  return (
    <FieldDescription id={path ? `${path}-help` : undefined}>
      <RichText markdown={field.help_md} />
    </FieldDescription>
  );
}

/**
 * Required is marked, optional is not.
 *
 * The opposite convention — marking the optional ones — reads better on a form
 * where most fields are optional, and these are not: a registration form is
 * mostly name and email. `aria-hidden` on the asterisk because the control
 * itself carries `required` for a screen reader.
 */
function RequiredMark({ required }: { required: boolean }) {
  if (!required) return null;
  return (
    <span className="text-destructive" aria-hidden>
      *
    </span>
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
