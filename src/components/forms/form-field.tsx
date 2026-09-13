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
import { Textarea } from '@/components/ui/textarea';
import type { FieldValue } from '@/lib/forms/field-types';
import type { FormField } from '@/lib/forms/schema';
import { RichText } from './rich-text';

/**
 * One field, in each of the ten types (spec/v2.md §8.2).
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

  return (
    <Field data-invalid={invalid || undefined}>
      <FieldLabel htmlFor={path}>
        {field.label}
        <RequiredMark required={field.required} />
      </FieldLabel>
      <Control {...props} invalid={invalid} />
      <Help field={field} />
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
  const shared = {
    id: path,
    disabled,
    'aria-invalid': invalid || undefined,
    'aria-describedby': field.help_md ? `${path}-help` : undefined,
    placeholder: field.placeholder,
  };

  switch (field.type) {
    case 'textarea':
      return (
        <Textarea
          {...shared}
          className="min-h-24 text-base md:text-sm"
          rows={4}
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

    default:
      return (
        <Input
          {...shared}
          className={CONTROL}
          type={field.type === 'email' ? 'email' : field.type === 'tel' ? 'tel' : 'text'}
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
