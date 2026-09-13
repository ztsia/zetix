'use client';

import { useId } from 'react';
import { Lock, Plus, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { Separator } from '@/components/ui/separator';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { FIELD_TYPES, isChoiceType, type FieldType } from '@/lib/forms/field-types';
import type { FormBlock, FormField } from '@/lib/forms/schema';
import { ConditionEditor } from './condition-editor';
import { isSystemField, type ConditionSource, type FieldPatch } from './operations';

/**
 * One question's settings (spec/v2.md §8.2).
 *
 * **A locked field shows three inputs, not eight.** Label, help text and
 * placeholder are the admin's; `key`, `type` and `required` are the column's,
 * and they are not rendered as disabled controls but simply not rendered —
 * a greyed-out dropdown invites the question "why can't I?", which is a
 * conversation about the constraint rather than about the form. The one line
 * that does appear says what the field is and why it stays.
 *
 * That constraint is what makes the mapping unfalsifiable: there is no
 * configuration in which the email question is not the email (decision 35).
 */

const TYPE_LABEL: Record<FieldType, string> = {
  text: 'Short text',
  textarea: 'Long text',
  email: 'Email address',
  tel: 'Phone number',
  number: 'Number',
  select: 'Dropdown',
  multiselect: 'Several from a list',
  checkbox: 'Tickbox',
  radio: 'One from a list',
  date: 'Date',
};

export function FieldEditor({
  block,
  field,
  sources,
  onChange,
}: {
  block: FormBlock;
  field: FormField;
  sources: ConditionSource[];
  onChange: (patch: FieldPatch) => void;
}) {
  const id = useId();
  const locked = isSystemField(block, field);

  return (
    <FieldGroup className="gap-4">
      <Field>
        <FieldLabel htmlFor={`${id}-label`}>Question</FieldLabel>
        <Input
          id={`${id}-label`}
          value={field.label}
          onChange={(event) => onChange({ label: event.target.value })}
        />
      </Field>

      {locked ? (
        <FieldDescription className="flex items-start gap-2">
          <Lock className="mt-0.5 size-3.5 shrink-0" />
          <span>
            This is the form&rsquo;s <strong>{field.key}</strong> question. Its wording is
            yours; what it collects is fixed, so an answer always reaches the right
            place. {field.required ? 'It is always required.' : 'It is optional.'}
          </span>
        </FieldDescription>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor={`${id}-type`}>Answer type</FieldLabel>
            <NativeSelect
              id={`${id}-type`}
              value={field.type}
              onChange={(event) => onChange({ type: event.target.value as FieldType })}
            >
              {FIELD_TYPES.map((type) => (
                <option key={type} value={type}>
                  {TYPE_LABEL[type]}
                </option>
              ))}
            </NativeSelect>
          </Field>

          <Field orientation="horizontal" className="sm:self-end sm:pb-2">
            <Switch
              id={`${id}-required`}
              checked={field.required}
              onCheckedChange={(checked: boolean) => onChange({ required: checked })}
            />
            <FieldLabel htmlFor={`${id}-required`}>Required</FieldLabel>
          </Field>
        </div>
      )}

      <Field>
        <FieldLabel htmlFor={`${id}-help`}>Help text</FieldLabel>
        <Textarea
          id={`${id}-help`}
          rows={2}
          value={field.help_md ?? ''}
          placeholder="Shown under the question. **Bold** and [links](https://example.org) work."
          onChange={(event) => onChange({ help_md: event.target.value })}
        />
      </Field>

      {field.type !== 'checkbox' && !isChoiceType(field.type) && (
        <Field>
          <FieldLabel htmlFor={`${id}-placeholder`}>Placeholder</FieldLabel>
          <Input
            id={`${id}-placeholder`}
            value={field.placeholder ?? ''}
            onChange={(event) => onChange({ placeholder: event.target.value })}
          />
        </Field>
      )}

      {!locked && isChoiceType(field.type) && (
        <OptionsEditor
          options={field.options ?? []}
          onChange={(options) => onChange({ options })}
        />
      )}

      {!locked && (
        <>
          <Separator />
          <ConditionEditor
            condition={field.condition}
            sources={sources}
            onChange={(condition) => onChange({ condition })}
          />
        </>
      )}
    </FieldGroup>
  );
}

/**
 * The choices a dropdown, radio group or multiselect offers.
 *
 * The stored `value` is derived from the label once, when the option is
 * created, and never re-derived on edit. Renaming "Vegetarian" to "Vegetarian
 * (no fish)" must not silently change what every answer already given *meant* —
 * and it would also strand any condition that reads the old value, which the
 * contract then refuses at save.
 */
function OptionsEditor({
  options,
  onChange,
}: {
  options: { value: string; label: string }[];
  onChange: (next: { value: string; label: string }[]) => void;
}) {
  const id = useId();

  function add() {
    const taken = new Set(options.map((option) => option.value));
    let n = options.length + 1;
    while (taken.has(`option_${n}`)) n += 1;
    onChange([...options, { value: `option_${n}`, label: `Option ${n}` }]);
  }

  return (
    <Field>
      <FieldLabel htmlFor={`${id}-0`}>Choices</FieldLabel>
      <div className="flex flex-col gap-2">
        {options.map((option, index) => (
          <div key={option.value} className="flex items-center gap-2">
            <Input
              id={`${id}-${index}`}
              value={option.label}
              onChange={(event) => {
                const next = [...options];
                next[index] = { ...option, label: event.target.value };
                onChange(next);
              }}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={`Remove ${option.label}`}
              disabled={options.length <= 1}
              onClick={() => onChange(options.filter((_, i) => i !== index))}
            >
              <X />
            </Button>
          </div>
        ))}
      </div>
      <Button type="button" variant="outline" size="sm" className="self-start" onClick={add}>
        <Plus />
        Add a choice
      </Button>
      <FieldDescription>
        A choice keeps the value it was created with, so renaming one here does not
        change what earlier answers meant.
      </FieldDescription>
    </Field>
  );
}
