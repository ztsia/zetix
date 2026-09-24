'use client';

import { useId, useState } from 'react';
import {
  AlignLeft,
  ArrowDown,
  ArrowUp,
  AtSign,
  Calendar,
  CircleChevronDown,
  CircleDot,
  Clock,
  Copy,
  Ellipsis,
  EllipsisVertical,
  GitBranch,
  Grid3x3,
  Grip,
  GripHorizontal,
  Hash,
  Lock,
  Minus,
  Phone,
  SquareCheck,
  SquareCheckBig,
  Star,
  Trash2,
  X,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
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
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { FormFieldControl } from '@/components/forms/form-field';
import { FormCard } from '@/components/forms/form-surface';
import {
  FIELD_TYPE_GROUPS,
  FIELD_TYPE_LABELS,
  isScaleType,
  type FieldType,
  type FormFieldScale,
} from '@/lib/forms/field-types';
import type { FormBlock, FormField } from '@/lib/forms/schema';
import { cn } from '@/lib/utils';
import { ConditionEditor } from './condition-editor';
import { canDeleteField, isSystemField, type ConditionSource, type FieldPatch } from './operations';

/**
 * One question in the builder, as a Google Forms card (spec/v2.md §8.2).
 *
 * **Two states, as there.** At rest the card shows the question exactly as a
 * registrant will meet it — drawn by the same `FormFieldControl` the public form
 * uses, so the builder's cards *are* the live preview §8.2.2b asks for. Click it
 * and it opens for editing: a blue bar down the left, the question in a grey
 * box, the type picker beside it, the answers editable in place, and along the
 * bottom duplicate, delete, Required and a ⋮ menu for the rarer settings.
 *
 * **A locked field shows only what is the admin's.** Its wording, help text and
 * placeholder can change; its type and `required` are the column's, so the type
 * picker is replaced by a chip saying what the question collects and the
 * Required switch by a line saying it always is (decision 35). They are not
 * rendered disabled — a greyed-out control invites "why can't I?", which is a
 * conversation about the constraint rather than about the form.
 *
 * **The type picker is Google Forms' own**, same names, same groups, same
 * pictures, because the admin choosing has almost certainly just come from
 * there.
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

function TypeIcon({ type, className }: { type: FieldType; className?: string }) {
  const Icon = TYPE_ICON[type];
  return <Icon className={cn('size-5 shrink-0 opacity-70', className)} />;
}

/** The types a placeholder means anything on: an empty text box, or a drop-down's null row. */
function takesPlaceholder(type: FieldType): boolean {
  return (
    type === 'text' ||
    type === 'textarea' ||
    type === 'email' ||
    type === 'tel' ||
    type === 'number' ||
    type === 'select'
  );
}

/** The answer-area line Google Forms draws for a typed answer, and what it says. */
const ANSWER_HINT: Partial<Record<FieldType, string>> = {
  text: 'Short-answer text',
  textarea: 'Long-answer text',
  email: 'Email address',
  tel: 'Phone number',
  number: 'Number',
};

/** The builder's grey question box: a filled field with an underline that thickens on focus. */
const TITLE_INPUT =
  'bg-muted/70 h-14 rounded-none rounded-t border-0 border-b border-muted-foreground/40 px-4 text-base shadow-none focus-visible:border-b-2 focus-visible:border-form-accent focus-visible:ring-0 md:text-base dark:bg-muted/70';

/** An inline, borderless-until-hovered underline input — an option's label, a scale's end. */
const INLINE_INPUT =
  'h-9 rounded-none border-0 border-b border-transparent bg-transparent px-0 text-sm shadow-none hover:border-form-line focus-visible:border-b-2 focus-visible:border-form-accent focus-visible:ring-0 dark:bg-transparent';

export type QuestionDragProps = {
  onDragStart: () => void;
  onDragEnd: () => void;
  onDragOver: (event: React.DragEvent) => void;
  onDrop: () => void;
  isDragging: boolean;
  isDropTarget: boolean;
};

export function QuestionCard({
  block,
  field,
  domId,
  active,
  readOnly,
  sources,
  canMoveUp,
  canMoveDown,
  onActivate,
  onChange,
  onDelete,
  onDuplicate,
  onMove,
  drag,
}: {
  block: FormBlock;
  field: FormField;
  /** The card's element id — the target a newly added question is scrolled to. */
  domId: string;
  active: boolean;
  readOnly: boolean;
  sources: ConditionSource[];
  canMoveUp: boolean;
  canMoveDown: boolean;
  onActivate: () => void;
  onChange: (patch: FieldPatch) => void;
  onDelete: () => void;
  onDuplicate: () => void;
  onMove: (direction: -1 | 1) => void;
  drag: QuestionDragProps;
}) {
  const locked = isSystemField(block, field);

  const dropProps = {
    onDragOver: drag.onDragOver,
    onDrop: drag.onDrop,
  };

  if (!active || readOnly) {
    return (
      <FormCard
        id={domId}
        {...dropProps}
        className={cn(
          'relative transition-shadow',
          !readOnly && 'hover:shadow-md',
          drag.isDragging && 'opacity-40',
          drag.isDropTarget && 'ring-form-focus ring-2',
        )}
      >
        {/*
          The whole card is the control that opens it, as on Google Forms. A
          real button laid over the preview, so it is one tab stop that says
          what it does — the preview's own controls are disabled and hidden
          from the tab order underneath it.
        */}
        {!readOnly && (
          <button
            type="button"
            aria-label={`Edit ${field.label}`}
            onClick={onActivate}
            className="focus-visible:ring-form-focus absolute inset-0 z-10 cursor-pointer rounded-lg focus-visible:ring-2 focus-visible:outline-none"
          />
        )}
        <div inert>
          <FormFieldControl
            field={field}
            path={`${domId}-preview`}
            value={null}
            onChange={() => {}}
            disabled
          />
        </div>
        {(locked || field.condition) && (
          <div className="mt-4 flex flex-wrap gap-2">
            {locked && (
              <Badge variant="secondary" className="gap-1 font-normal">
                <Lock className="size-3" />
                Fixed question
              </Badge>
            )}
            {field.condition && (
              <Badge variant="outline" className="gap-1 font-normal">
                <GitBranch className="size-3" />
                Shown only when{' '}
                {sources.find((s) => s.key === field.condition?.field)?.label ??
                  'another answer'}{' '}
                matches
              </Badge>
            )}
          </div>
        )}
      </FormCard>
    );
  }

  return (
    <ActiveQuestion
      block={block}
      field={field}
      domId={domId}
      locked={locked}
      sources={sources}
      canMoveUp={canMoveUp}
      canMoveDown={canMoveDown}
      onChange={onChange}
      onDelete={onDelete}
      onDuplicate={onDuplicate}
      onMove={onMove}
      drag={drag}
    />
  );
}

function ActiveQuestion({
  block,
  field,
  domId,
  locked,
  sources,
  canMoveUp,
  canMoveDown,
  onChange,
  onDelete,
  onDuplicate,
  onMove,
  drag,
}: {
  block: FormBlock;
  field: FormField;
  domId: string;
  locked: boolean;
  sources: ConditionSource[];
  canMoveUp: boolean;
  canMoveDown: boolean;
  onChange: (patch: FieldPatch) => void;
  onDelete: () => void;
  onDuplicate: () => void;
  onMove: (direction: -1 | 1) => void;
  drag: QuestionDragProps;
}) {
  const id = useId();

  /**
   * The ⋮ menu's toggles, as on Google Forms: Description and the rest are off
   * until asked for, so a plain question is a plain card. A toggle that is on
   * because the field already carries a value starts on.
   */
  const [showHelp, setShowHelp] = useState(Boolean(field.help_md));
  const [showPlaceholder, setShowPlaceholder] = useState(Boolean(field.placeholder));
  const [showCondition, setShowCondition] = useState(Boolean(field.condition));

  return (
    <FormCard
      id={domId}
      onDragOver={drag.onDragOver}
      onDrop={drag.onDrop}
      className={cn(
        'relative overflow-hidden p-0 shadow-md',
        drag.isDropTarget && 'ring-form-focus ring-2',
      )}
    >
      <div className="bg-form-focus absolute inset-y-0 left-0 w-1.5" aria-hidden />

      {/*
        The drag handle, top centre. Only the handle is draggable, so selecting
        text in the question box never starts a drag. The ⋮ menu's Move up and
        Move down are the same move for a keyboard.
      */}
      <div className="flex justify-center">
        <span
          draggable
          onDragStart={(event) => {
            event.dataTransfer.effectAllowed = 'move';
            drag.onDragStart();
          }}
          onDragEnd={drag.onDragEnd}
          className="text-muted-foreground hover:text-foreground cursor-grab px-3 pt-1 active:cursor-grabbing"
          title="Drag to reorder"
          aria-hidden
        >
          <GripHorizontal className="size-5" />
        </span>
      </div>

      <div className="flex flex-col gap-4 px-6 pb-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
          <Input
            aria-label="Question"
            value={field.label}
            placeholder="Question"
            autoFocus
            onFocus={(event) => {
              // A fresh question's placeholder wording is selected, so typing
              // replaces it — which is what Google Forms does.
              if (field.label === 'New question' || field.label === 'Untitled question') {
                event.currentTarget.select();
              }
            }}
            onChange={(event) => onChange({ label: event.target.value })}
            className={cn(TITLE_INPUT, 'flex-1')}
          />

          {locked ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <span className="border-form-line text-muted-foreground flex h-14 items-center gap-3 rounded border px-4 text-sm sm:w-64" />
                }
              >
                <TypeIcon type={field.type} />
                <span className="flex-1">{FIELD_TYPE_LABELS[field.type].label}</span>
                <Lock className="size-4" />
              </TooltipTrigger>
              <TooltipContent className="max-w-64">
                This question fills the registration&rsquo;s {field.key} field, so what it collects
                stays fixed. Its wording is yours.
              </TooltipContent>
            </Tooltip>
          ) : (
            <TypePicker
              id={`${id}-type`}
              value={field.type}
              onChange={(type) => onChange({ type })}
            />
          )}
        </div>

        {showHelp && (
          <Textarea
            aria-label="Description"
            value={field.help_md ?? ''}
            placeholder="Description"
            rows={1}
            onChange={(event) => onChange({ help_md: event.target.value })}
            className={cn(INLINE_INPUT, 'field-sizing-content min-h-9 resize-none py-2')}
          />
        )}

        <AnswerEditor field={field} locked={locked} onChange={onChange} />

        {showPlaceholder && takesPlaceholder(field.type) && (
          <div className="flex items-center gap-3">
            <span className="text-muted-foreground w-28 shrink-0 text-xs">Placeholder</span>
            <Input
              aria-label="Placeholder"
              value={field.placeholder ?? ''}
              placeholder={field.type === 'select' ? 'Choose' : 'Your answer'}
              onChange={(event) => onChange({ placeholder: event.target.value })}
              className={cn(INLINE_INPUT, 'border-form-line max-w-xs')}
            />
          </div>
        )}

        {showCondition && !locked && (
          <div className="bg-muted/50 rounded-md p-4">
            <ConditionEditor
              condition={field.condition}
              sources={sources}
              onChange={(condition) => onChange({ condition })}
            />
          </div>
        )}

        {locked && (
          <p className="text-muted-foreground flex items-start gap-2 text-xs">
            <Lock className="mt-0.5 size-3.5 shrink-0" />
            <span>
              This is the form&rsquo;s <strong>{field.key}</strong> question. Its wording is yours;
              what it collects is fixed, so an answer always reaches the right place.
            </span>
          </p>
        )}
      </div>

      <div className="mx-6 flex flex-wrap items-center justify-end gap-1 border-t border-form-line py-2">
        <span
          className="text-muted-foreground mr-auto truncate font-mono text-xs"
          title="The name this answer is stored and exported under"
        >
          {field.key}
        </span>

        {!locked && (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={`Duplicate ${field.label}`}
                  onClick={onDuplicate}
                />
              }
            >
              <Copy />
            </TooltipTrigger>
            <TooltipContent>Duplicate</TooltipContent>
          </Tooltip>
        )}

        {canDeleteField(block, field) && (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={`Delete ${field.label}`}
                  onClick={onDelete}
                />
              }
            >
              <Trash2 />
            </TooltipTrigger>
            <TooltipContent>Delete</TooltipContent>
          </Tooltip>
        )}

        <Separator orientation="vertical" className="mx-2 h-8" />

        {locked ? (
          <span className="text-muted-foreground px-2 text-sm">
            {field.required ? 'Always required' : 'Always optional'}
          </span>
        ) : (
          <label htmlFor={`${id}-required`} className="flex items-center gap-3 px-2 text-sm">
            Required
            <Switch
              id={`${id}-required`}
              checked={field.required}
              onCheckedChange={(checked: boolean) => onChange({ required: checked })}
            />
          </label>
        )}

        <DropdownMenu>
          <DropdownMenuTrigger
            render={<Button type="button" variant="ghost" size="icon" aria-label="More options" />}
          >
            <EllipsisVertical />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            {/* base-ui wants every label inside a group. */}
            <DropdownMenuGroup>
              <DropdownMenuLabel>Show</DropdownMenuLabel>
              <DropdownMenuCheckboxItem
                checked={showHelp}
                onCheckedChange={(on) => {
                  setShowHelp(on);
                  // Unticking removes the text, as on Google Forms: a hidden
                  // description that still renders would be a trap.
                  if (!on) onChange({ help_md: null });
                }}
              >
                Description
              </DropdownMenuCheckboxItem>
              {takesPlaceholder(field.type) && (
                <DropdownMenuCheckboxItem
                  checked={showPlaceholder}
                  onCheckedChange={(on) => {
                    setShowPlaceholder(on);
                    if (!on) onChange({ placeholder: null });
                  }}
                >
                  Placeholder text
                </DropdownMenuCheckboxItem>
              )}
              {!locked && (
                <DropdownMenuCheckboxItem
                  checked={showCondition}
                  onCheckedChange={(on) => {
                    setShowCondition(on);
                    if (!on) onChange({ condition: null });
                  }}
                >
                  Show only when…
                </DropdownMenuCheckboxItem>
              )}
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled={!canMoveUp} onClick={() => onMove(-1)}>
              <ArrowUp />
              Move up
            </DropdownMenuItem>
            <DropdownMenuItem disabled={!canMoveDown} onClick={() => onMove(1)}>
              <ArrowDown />
              Move down
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </FormCard>
  );
}

/**
 * Google Forms' type picker: a box with the type's picture and name, opening a
 * grouped list. Always the label, never the stored value — base-ui renders the
 * raw value when `SelectValue` is left empty, which would show "textarea" where
 * the list says "Paragraph".
 */
function TypePicker({
  id,
  value,
  onChange,
}: {
  id: string;
  value: FieldType;
  onChange: (type: FieldType) => void;
}) {
  return (
    <Select value={value} onValueChange={(next) => onChange(next as FieldType)}>
      <SelectTrigger
        id={id}
        aria-label="Answer type"
        className="border-form-line h-14! w-full rounded px-4 sm:w-64"
      >
        <SelectValue>
          <span className="flex items-center gap-3">
            <TypeIcon type={value} />
            {FIELD_TYPE_LABELS[value].label}
          </span>
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {FIELD_TYPE_GROUPS.map((group) => (
          <SelectGroup key={group.label}>
            <SelectLabel>{group.label}</SelectLabel>
            {group.types.map((type) => (
              <SelectItem key={type} value={type} className="py-2">
                <span className="flex items-center gap-3">
                  <TypeIcon type={type} />
                  {FIELD_TYPE_LABELS[type].label}
                </span>
              </SelectItem>
            ))}
          </SelectGroup>
        ))}
      </SelectContent>
    </Select>
  );
}

/**
 * The answer area of an open card, per type — edited in place, the way Google
 * Forms edits it, rather than in a settings panel beside the question.
 */
function AnswerEditor({
  field,
  locked,
  onChange,
}: {
  field: FormField;
  locked: boolean;
  onChange: (patch: FieldPatch) => void;
}) {
  const hint = ANSWER_HINT[field.type];
  if (hint) {
    return (
      <p className="text-muted-foreground border-muted-foreground/50 w-full border-b border-dotted pb-1 text-sm sm:w-1/2">
        {hint}
      </p>
    );
  }

  // A locked field is one of the text types above; nothing below applies to it.
  if (locked) return null;

  switch (field.type) {
    case 'radio':
    case 'multiselect':
    case 'select':
      return (
        <OptionList
          marker={
            field.type === 'radio' ? 'radio' : field.type === 'multiselect' ? 'checkbox' : 'number'
          }
          noun="option"
          prefix="option"
          items={field.options ?? []}
          onChange={(options) => onChange({ options })}
        />
      );

    case 'grid_radio':
    case 'grid_checkbox':
      return (
        <div className="grid gap-6 sm:grid-cols-2">
          <div className="flex flex-col gap-1">
            <p className="text-sm font-medium">Rows</p>
            <OptionList
              marker="number"
              noun="row"
              prefix="row"
              items={field.rows ?? []}
              onChange={(rows) => onChange({ rows })}
            />
          </div>
          <div className="flex flex-col gap-1">
            <p className="text-sm font-medium">Columns</p>
            <OptionList
              marker={field.type === 'grid_radio' ? 'radio' : 'checkbox'}
              noun="column"
              prefix="option"
              items={field.options ?? []}
              onChange={(options) => onChange({ options })}
            />
          </div>
        </div>
      );

    case 'scale':
    case 'rating':
      return isScaleType(field.type) ? (
        <ScaleEditor
          type={field.type}
          scale={field.scale ?? { min: 1, max: 5 }}
          onChange={(scale) => onChange({ scale })}
        />
      ) : null;

    case 'date':
      return (
        <p className="text-muted-foreground border-muted-foreground/50 flex w-48 items-center justify-between border-b border-dotted pb-1 text-sm">
          Month, day, year
          <Calendar className="size-4" />
        </p>
      );

    case 'time':
      return (
        <p className="text-muted-foreground border-muted-foreground/50 flex w-32 items-center justify-between border-b border-dotted pb-1 text-sm">
          Time
          <Clock className="size-4" />
        </p>
      );

    case 'checkbox':
      return (
        <p className="text-muted-foreground flex items-center gap-3 text-sm">
          <span
            className="border-muted-foreground size-[18px] rounded-[2px] border-2"
            aria-hidden
          />
          The question above sits beside a single box to tick.
        </p>
      );

    default:
      return null;
  }
}

type Marker = 'radio' | 'checkbox' | 'number';

function MarkerGlyph({ marker, index }: { marker: Marker; index: number }) {
  if (marker === 'number') {
    return (
      <span className="text-muted-foreground w-5 text-right text-sm tabular-nums">
        {index + 1}.
      </span>
    );
  }
  return (
    <span
      aria-hidden
      className={cn(
        'border-muted-foreground/60 size-5 shrink-0 border-2',
        marker === 'radio' ? 'rounded-full' : 'size-[18px] rounded-[2px]',
      )}
    />
  );
}

/**
 * An editable list — a question's options, a grid's rows, a grid's columns — as
 * Google Forms draws one: the answer's own mark, the label editable in place,
 * an ✕ at the end of the row, and a greyed "Add option" underneath.
 *
 * **One component for all three**, because they are the same thing pointed in
 * different directions.
 *
 * **A value is minted once and never re-derived.** Renaming "Vegetarian" to
 * "Vegetarian (no fish)" must not change what every answer already given
 * meant, and it would strand any condition that reads the old value — which
 * the contract then refuses at save.
 *
 * **Enter adds the next one**, straight after, and focuses it — so a list of
 * six is typed in one go, as on Google Forms.
 */
function OptionList({
  marker,
  noun,
  prefix,
  items,
  onChange,
}: {
  marker: Marker;
  noun: 'option' | 'row' | 'column';
  prefix: string;
  items: { value: string; label: string }[];
  onChange: (next: { value: string; label: string }[]) => void;
}) {
  const [focusValue, setFocusValue] = useState<string | null>(null);
  const Noun = noun.charAt(0).toUpperCase() + noun.slice(1);

  function insertAt(index: number) {
    const taken = new Set(items.map((item) => item.value));
    let n = items.length + 1;
    while (taken.has(`${prefix}_${n}`)) n += 1;
    const next = [...items];
    next.splice(index, 0, { value: `${prefix}_${n}`, label: `${Noun} ${n}` });
    setFocusValue(`${prefix}_${n}`);
    onChange(next);
  }

  return (
    <div className="flex flex-col">
      {items.map((item, index) => (
        <div key={item.value} className="group/option flex items-center gap-3">
          <MarkerGlyph marker={marker} index={index} />
          <Input
            aria-label={`${Noun} ${index + 1}`}
            value={item.label}
            autoFocus={item.value === focusValue}
            onFocus={(event) => {
              if (item.value === focusValue) event.currentTarget.select();
            }}
            onChange={(event) => {
              const next = [...items];
              next[index] = { ...item, label: event.target.value };
              onChange(next);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                insertAt(index + 1);
              }
            }}
            className={cn(INLINE_INPUT, 'flex-1')}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={`Remove ${item.label}`}
            disabled={items.length <= 1}
            onClick={() => onChange(items.filter((_, i) => i !== index))}
            className="text-muted-foreground"
          >
            <X />
          </Button>
        </div>
      ))}
      <div className="flex items-center gap-3">
        <MarkerGlyph marker={marker} index={items.length} />
        <button
          type="button"
          onClick={() => insertAt(items.length)}
          className="text-muted-foreground hover:border-form-line h-9 border-b border-transparent text-left text-sm focus-visible:outline-none focus-visible:border-form-accent"
        >
          Add {noun}
        </button>
      </div>
    </div>
  );
}

/**
 * Google Forms' linear scale editor — "1 ▾ to 5 ▾", then a label for each end —
 * and its rating editor: how many, and the stars they make.
 *
 * **A rating has no floor and no end labels**, because it has neither: it always
 * starts at one star. Offering the controls and ignoring them would be the
 * greyed-out-dropdown problem again.
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
  // The top is offered from one above the floor: a scale whose top is at or
  // below its bottom is refused by the contract, so it is never offered.
  const floor = isRating ? 1 : scale.min;
  const tops = Array.from({ length: 10 - floor }, (_, i) => floor + 1 + i);

  const numberSelect = (
    selectId: string,
    label: string,
    value: number,
    options: number[],
    set: (n: number) => void,
  ) => (
    <Select value={String(value)} onValueChange={(next) => set(Number(next))}>
      <SelectTrigger id={selectId} aria-label={label} className="w-20">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((n) => (
          <SelectItem key={n} value={String(n)}>
            {n}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );

  if (isRating) {
    return (
      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-3">
          {numberSelect(`${id}-max`, 'How many stars', scale.max, tops, (max) =>
            onChange({ ...scale, max }),
          )}
          <Star className="fill-form-accent text-form-accent size-5" aria-hidden />
        </div>
        <div className="flex flex-wrap justify-center gap-4" aria-hidden>
          {Array.from({ length: scale.max }, (_, i) => (
            <span key={i} className="flex flex-col items-center gap-2 text-sm">
              {i + 1}
              <Star className="text-muted-foreground size-7 stroke-[1.5]" />
            </span>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3 text-sm">
        {numberSelect(`${id}-min`, 'Scale starts at', scale.min, [0, 1], (min) =>
          onChange({ ...scale, min, max: Math.max(scale.max, min + 1) }),
        )}
        to
        {numberSelect(`${id}-max`, 'Scale ends at', scale.max, tops, (max) =>
          onChange({ ...scale, max }),
        )}
      </div>
      {(['min', 'max'] as const).map((end) => (
        <div key={end} className="flex items-center gap-4">
          <span className="text-muted-foreground w-5 text-sm tabular-nums">{scale[end]}</span>
          <Input
            aria-label={`Label for ${scale[end]}`}
            value={(end === 'min' ? scale.min_label : scale.max_label) ?? ''}
            placeholder="Label (optional)"
            onChange={(event) =>
              onChange({
                ...scale,
                [end === 'min' ? 'min_label' : 'max_label']: event.target.value || undefined,
              })
            }
            className={cn(INLINE_INPUT, 'border-form-line max-w-xs')}
          />
        </div>
      ))}
    </div>
  );
}
