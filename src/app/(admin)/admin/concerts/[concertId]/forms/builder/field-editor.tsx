'use client';

import { useId } from 'react';
import {
  AlignLeft,
  AtSign,
  Calendar,
  CircleChevronDown,
  CircleDot,
  Clock,
  Ellipsis,
  Grid3x3,
  Grip,
  Hash,
  Lock,
  Minus,
  Phone,
  Plus,
  SquareCheck,
  SquareCheckBig,
  Star,
  X,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import {
  FIELD_TYPE_GROUPS,
  FIELD_TYPE_LABELS,
  isGridType,
  isOptionType,
  isScaleType,
  type FieldType,
  type FormFieldScale,
} from '@/lib/forms/field-types';
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
 *
 * **The type picker is grouped and illustrated on purpose.** Every admin here
 * arrives from Google Forms — both registration rounds of this concert were
 * collected there — and a flat list of fifteen internal names is a worse
 * version of a control they already know. Same groups, same order, same
 * pictures, so choosing a question type needs no translation.
 */

const TYPE_ICON: Record<FieldType, LucideIcon> = {
  text: Minus,
  textarea: AlignLeft,
  radio: CircleDot,
  multiselect: SquareCheck,
  select: CircleChevronDown,
  scale: Ellipsis,
  rating: Star,
  grid_radio: Grip,
  grid_checkbox: Grid3x3,
  date: Calendar,
  time: Clock,
  checkbox: SquareCheckBig,
  email: AtSign,
  tel: Phone,
  number: Hash,
};

/** The picture for a type, at the one size the picker uses it. */
function TypeIcon({ type }: { type: FieldType }) {
  const Icon = TYPE_ICON[type];
  return <Icon className="size-4 shrink-0 opacity-70" />;
}

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

  /**
   * A placeholder labels an empty text box or a drop-down's null row. Neither
   * exists on a tick box, a scale, a grid or a date — so the input is not
   * offered rather than offered and ignored.
   */
  const takesPlaceholder =
    field.type === 'text' ||
    field.type === 'textarea' ||
    field.type === 'email' ||
    field.type === 'tel' ||
    field.type === 'number' ||
    field.type === 'select';

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
            <Select
              value={field.type}
              onValueChange={(value) => onChange({ type: value as FieldType })}
            >
              <SelectTrigger id={`${id}-type`} className="w-full">
                {/*
                  The label, not the value. base-ui renders the raw value when
                  `Value` is left empty, so the trigger would read "textarea"
                  where the open list reads "Paragraph" — the one place the
                  internal name must never surface.
                */}
                <SelectValue>
                  <span className="flex items-center gap-2">
                    <TypeIcon type={field.type} />
                    {FIELD_TYPE_LABELS[field.type].label}
                  </span>
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {FIELD_TYPE_GROUPS.map((group) => (
                  <SelectGroup key={group.label}>
                    <SelectLabel>{group.label}</SelectLabel>
                    {group.types.map((type) => (
                      <SelectItem key={type} value={type}>
                        <span className="flex items-center gap-2">
                          <TypeIcon type={type} />
                          {FIELD_TYPE_LABELS[type].label}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectGroup>
                ))}
              </SelectContent>
            </Select>
            <FieldDescription>{FIELD_TYPE_LABELS[field.type].hint}</FieldDescription>
          </Field>

          <Field orientation="horizontal" className="sm:self-start sm:pt-8">
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

      {takesPlaceholder && (
        <Field>
          <FieldLabel htmlFor={`${id}-placeholder`}>Placeholder</FieldLabel>
          <Input
            id={`${id}-placeholder`}
            value={field.placeholder ?? ''}
            onChange={(event) => onChange({ placeholder: event.target.value })}
          />
        </Field>
      )}

      {!locked && isOptionType(field.type) && (
        <ListEditor
          legend={isGridType(field.type) ? 'Columns' : 'Choices'}
          noun={isGridType(field.type) ? 'column' : 'choice'}
          prefix="option"
          items={field.options ?? []}
          onChange={(options) => onChange({ options })}
        />
      )}

      {!locked && isGridType(field.type) && (
        <ListEditor
          legend="Rows"
          noun="row"
          prefix="row"
          items={field.rows ?? []}
          onChange={(rows) => onChange({ rows })}
        />
      )}

      {!locked && isScaleType(field.type) && (
        <ScaleEditor
          type={field.type}
          scale={field.scale ?? { min: 1, max: 5 }}
          onChange={(scale) => onChange({ scale })}
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
 * An editable list of labelled values — a choice list, a grid's columns, or a
 * grid's rows.
 *
 * **One component for all three** because they are the same thing pointed in
 * different directions, and a second copy would be a second place for the
 * value-stability rule below to be got wrong.
 *
 * The stored `value` is derived once, when the entry is created, and never
 * re-derived on edit. Renaming "Vegetarian" to "Vegetarian (no fish)" must not
 * silently change what every answer already given *meant* — and it would also
 * strand any condition that reads the old value, which the contract then
 * refuses at save.
 */
function ListEditor({
  legend,
  noun,
  prefix,
  items,
  onChange,
}: {
  legend: string;
  noun: string;
  prefix: string;
  items: { value: string; label: string }[];
  onChange: (next: { value: string; label: string }[]) => void;
}) {
  const id = useId();

  function add() {
    const taken = new Set(items.map((item) => item.value));
    let n = items.length + 1;
    while (taken.has(`${prefix}_${n}`)) n += 1;
    onChange([...items, { value: `${prefix}_${n}`, label: `${legend.replace(/s$/, '')} ${n}` }]);
  }

  return (
    <Field>
      <FieldLabel htmlFor={`${id}-0`}>{legend}</FieldLabel>
      <div className="flex flex-col gap-2">
        {items.map((item, index) => (
          <div key={item.value} className="flex items-center gap-2">
            <Input
              id={`${id}-${index}`}
              value={item.label}
              onChange={(event) => {
                const next = [...items];
                next[index] = { ...item, label: event.target.value };
                onChange(next);
              }}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={`Remove ${item.label}`}
              disabled={items.length <= 1}
              onClick={() => onChange(items.filter((_, i) => i !== index))}
            >
              <X />
            </Button>
          </div>
        ))}
      </div>
      <Button type="button" variant="outline" size="sm" className="self-start" onClick={add}>
        <Plus />
        Add a {noun}
      </Button>
      <FieldDescription>
        A {noun} keeps the value it was created with, so renaming one here does not
        change what earlier answers meant.
      </FieldDescription>
    </Field>
  );
}

/**
 * The bounds of a linear scale, or the number of stars on a rating.
 *
 * **A rating hides the floor and the end labels**, because it has neither: it
 * always starts at one star and a star row labelled at both ends is a linear
 * scale wearing a different picture. Offering the controls and ignoring them
 * would be the greyed-out dropdown problem again.
 */
function ScaleEditor({
  type,
  scale,
  onChange,
}: {
  type: 'scale' | 'rating';
  scale: FormFieldScale;
  onChange: (next: FormFieldScale) => void;
}) {
  const id = useId();
  const isRating = type === 'rating';

  return (
    <Field>
      <FieldLabel>{isRating ? 'Stars' : 'Scale'}</FieldLabel>
      <div className="flex flex-wrap items-end gap-3">
        {!isRating && (
          <div className="flex flex-col gap-1.5">
            <FieldLabel htmlFor={`${id}-min`} className="text-xs font-normal text-muted-foreground">
              From
            </FieldLabel>
            <Select
              value={String(scale.min)}
              onValueChange={(value) => onChange({ ...scale, min: Number(value) })}
            >
              <SelectTrigger id={`${id}-min`} className="w-20">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="0">0</SelectItem>
                <SelectItem value="1">1</SelectItem>
              </SelectContent>
            </Select>
          </div>
        )}

        <div className="flex flex-col gap-1.5">
          <FieldLabel htmlFor={`${id}-max`} className="text-xs font-normal text-muted-foreground">
            {isRating ? 'How many' : 'To'}
          </FieldLabel>
          <Select
            value={String(scale.max)}
            onValueChange={(value) => onChange({ ...scale, max: Number(value) })}
          >
            <SelectTrigger id={`${id}-max`} className="w-20">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {/*
                Starts at the floor plus one: a scale whose top is at or below
                its bottom is refused by the contract, so it is not offered.
              */}
              {Array.from({ length: 10 - (isRating ? 1 : scale.min) }, (_, i) => i + (isRating ? 2 : scale.min + 1))
                .filter((n) => n >= 2 && n <= 10)
                .map((n) => (
                  <SelectItem key={n} value={String(n)}>
                    {n}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex items-center gap-1 pb-2 text-muted-foreground">
          {isRating ? (
            Array.from({ length: scale.max }, (_, i) => (
              <Star key={i} className="size-4" />
            ))
          ) : (
            <span className="text-sm tabular-nums">
              {scale.min} &ndash; {scale.max}
            </span>
          )}
        </div>
      </div>

      {!isRating && (
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <FieldLabel
              htmlFor={`${id}-minlabel`}
              className="text-xs font-normal text-muted-foreground"
            >
              Label for {scale.min}
            </FieldLabel>
            <Input
              id={`${id}-minlabel`}
              value={scale.min_label ?? ''}
              placeholder="Not at all"
              onChange={(event) =>
                onChange({ ...scale, min_label: event.target.value || undefined })
              }
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <FieldLabel
              htmlFor={`${id}-maxlabel`}
              className="text-xs font-normal text-muted-foreground"
            >
              Label for {scale.max}
            </FieldLabel>
            <Input
              id={`${id}-maxlabel`}
              value={scale.max_label ?? ''}
              placeholder="Very much"
              onChange={(event) =>
                onChange({ ...scale, max_label: event.target.value || undefined })
              }
            />
          </div>
        </div>
      )}

      <FieldDescription>
        {isRating
          ? 'Answered by picking a number of stars.'
          : 'End labels are optional; the numbers show either way.'}
      </FieldDescription>
    </Field>
  );
}
