'use client';

import { useState } from 'react';
import {
  ChevronDown,
  ChevronUp,
  GripVertical,
  Lock,
  Plus,
  Settings2,
  Trash2,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ButtonGroup } from '@/components/ui/button-group';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Collapsible, CollapsibleContent } from '@/components/ui/collapsible';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Item, ItemActions, ItemContent, ItemDescription, ItemTitle } from '@/components/ui/item';
import { NativeSelect } from '@/components/ui/native-select';
import { Textarea } from '@/components/ui/textarea';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { blockFields, isRepeaterType, type FormBlock, type FormSchema } from '@/lib/forms/schema';
import { COPY_TOKENS } from '@/lib/forms/copy';
import { FieldEditor } from './field-editor';
import {
  BLOCK_HELP,
  BLOCK_LABEL,
  canDeleteField,
  conditionSources,
  isCustomBlock,
  isSystemField,
  restorableSystemFields,
  type FieldPatch,
} from './operations';

/**
 * One block and its questions (spec/v2.md §8.2).
 *
 * **System blocks are pre-built from `kind` and cannot be added or deleted**, so
 * they render with no delete control and no drag handle at all, rather than with
 * disabled ones. Their locked rows carry a lock badge that says what the field
 * is for; everything else in the block — its title, its copy, and any custom
 * question added to it — is the admin's.
 *
 * The move controls are buttons as well as a drag handle, deliberately. Drag is
 * what an admin reaches for and it is the shape the spec asks for; buttons are
 * what a keyboard reaches for, and this console is explicitly keyboard-friendly
 * (`surfaces.md` §15.1). Neither is a fallback for the other.
 */

export function BlockEditor({
  schema,
  block,
  index,
  isDragging,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  onMove,
  onDelete,
  onCopyChange,
  onAddField,
  onRestoreField,
  onFieldChange,
  onFieldMove,
  onFieldDelete,
}: {
  schema: FormSchema;
  block: FormBlock;
  index: number;
  isDragging: boolean;
  onDragStart: () => void;
  onDragOver: (event: React.DragEvent) => void;
  onDrop: () => void;
  onDragEnd: () => void;
  onMove: (direction: -1 | 1) => void;
  onDelete: () => void;
  onCopyChange: (patch: { title?: string; description_md?: string | null; add_label?: string | null }) => void;
  onAddField: () => void;
  onRestoreField: (key: string) => void;
  onFieldChange: (fieldIndex: number, patch: FieldPatch) => void;
  onFieldMove: (fieldIndex: number, direction: -1 | 1) => void;
  onFieldDelete: (fieldIndex: number) => void;
}) {
  const [openField, setOpenField] = useState<number | null>(null);
  const custom = isCustomBlock(block);
  const fields = blockFields(block);
  const restorable = restorableSystemFields(block);

  return (
    <Card
      className={isDragging ? 'opacity-50' : undefined}
      draggable={custom}
      onDragStart={custom ? onDragStart : undefined}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      data-block-id={block.id}
    >
      <CardHeader className="gap-3">
        <div className="flex items-start gap-2">
          {custom ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <span className="text-muted-foreground mt-2 cursor-grab active:cursor-grabbing">
                    <GripVertical className="size-4" />
                  </span>
                }
              />
              <TooltipContent>Drag to reorder, or use the arrows</TooltipContent>
            </Tooltip>
          ) : (
            <Tooltip>
              <TooltipTrigger
                render={
                  <span className="text-muted-foreground mt-2">
                    <Lock className="size-4" />
                  </span>
                }
              />
              <TooltipContent>
                This section comes from the form&rsquo;s kind and stays where it is
              </TooltipContent>
            </Tooltip>
          )}

          <div className="flex-1">
            <Input
              value={block.title}
              aria-label={`${BLOCK_LABEL[block.type]} title`}
              className="h-9 font-medium"
              onChange={(event) => onCopyChange({ title: event.target.value })}
            />
          </div>

          <Badge variant={custom ? 'outline' : 'secondary'} className="mt-1.5 shrink-0">
            {BLOCK_LABEL[block.type]}
          </Badge>

          {custom && (
            <ButtonGroup aria-label="Move section">
              <Button
                type="button"
                variant="outline"
                size="icon"
                aria-label="Move section up"
                onClick={() => onMove(-1)}
              >
                <ChevronUp />
              </Button>
              <Button
                type="button"
                variant="outline"
                size="icon"
                aria-label="Move section down"
                onClick={() => onMove(1)}
              >
                <ChevronDown />
              </Button>
              <Button
                type="button"
                variant="outline"
                size="icon"
                aria-label={`Delete the "${block.title}" section`}
                onClick={onDelete}
              >
                <Trash2 />
              </Button>
            </ButtonGroup>
          )}
        </div>

        <FieldDescription>{BLOCK_HELP[block.type]}</FieldDescription>

        <Field>
          <FieldLabel htmlFor={`${block.id}-description`}>Section copy</FieldLabel>
          <Textarea
            id={`${block.id}-description`}
            rows={2}
            value={block.description_md ?? ''}
            placeholder="Shown under the heading."
            onChange={(event) => onCopyChange({ description_md: event.target.value })}
          />
          <FieldDescription>
            {/* Copy interpolates resolved settings so a form's own text never
                hardcodes a number either (spec/README.md §2.1). */}
            Write <code className="text-xs">{'{{base_quota}}'}</code> and the like rather
            than a number, and the form fills it in from this segment&rsquo;s settings:{' '}
            {COPY_TOKENS.map((entry) => `{{${entry.token}}}`).join(', ')}.
          </FieldDescription>
        </Field>

        {isRepeaterType(block.type) && (
          <Field>
            <FieldLabel htmlFor={`${block.id}-add-label`}>“Add another” label</FieldLabel>
            <Input
              id={`${block.id}-add-label`}
              value={'add_label' in block ? (block.add_label ?? '') : ''}
              placeholder="Add a seat"
              onChange={(event) => onCopyChange({ add_label: event.target.value })}
            />
          </Field>
        )}
      </CardHeader>

      <CardContent className="flex flex-col gap-2">
        {fields.length === 0 && (
          <p className="text-muted-foreground rounded-md border border-dashed px-3 py-6 text-center text-sm">
            No questions in this section yet.
          </p>
        )}

        {fields.map((field, fieldIndex) => {
          const locked = isSystemField(block, field);
          const open = openField === fieldIndex;

          return (
            <Collapsible key={field.key} open={open}>
              <Item variant="outline" size="sm" className="flex-wrap">
                <ItemContent>
                  <ItemTitle className="flex items-center gap-2">
                    {field.label}
                    {field.required && <span className="text-destructive">*</span>}
                    {locked && (
                      <Badge variant="secondary" className="gap-1 font-normal">
                        <Lock className="size-3" />
                        fixed
                      </Badge>
                    )}
                    {field.condition && (
                      <Badge variant="outline" className="font-normal">
                        conditional
                      </Badge>
                    )}
                  </ItemTitle>
                  <ItemDescription>
                    {field.key} · {field.type}
                  </ItemDescription>
                </ItemContent>

                <ItemActions>
                  <ButtonGroup aria-label={`Reorder ${field.label}`}>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={`Move ${field.label} up`}
                      onClick={() => onFieldMove(fieldIndex, -1)}
                    >
                      <ChevronUp />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={`Move ${field.label} down`}
                      onClick={() => onFieldMove(fieldIndex, 1)}
                    >
                      <ChevronDown />
                    </Button>
                  </ButtonGroup>

                  <Button
                    type="button"
                    variant={open ? 'secondary' : 'ghost'}
                    size="icon"
                    aria-label={`Edit ${field.label}`}
                    aria-expanded={open}
                    onClick={() => setOpenField(open ? null : fieldIndex)}
                  >
                    <Settings2 />
                  </Button>

                  {canDeleteField(block, field) && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={`Delete ${field.label}`}
                      onClick={() => {
                        setOpenField(null);
                        onFieldDelete(fieldIndex);
                      }}
                    >
                      <Trash2 />
                    </Button>
                  )}
                </ItemActions>
              </Item>

              <CollapsibleContent>
                <div className="bg-muted/40 mt-1 rounded-md border p-4">
                  <FieldEditor
                    block={block}
                    field={field}
                    sources={conditionSources(schema, index, fieldIndex)}
                    onChange={(patch) => onFieldChange(fieldIndex, patch)}
                  />
                </div>
              </CollapsibleContent>
            </Collapsible>
          );
        })}

        <div className="flex flex-wrap gap-2 pt-1">
          <Button type="button" variant="outline" size="sm" onClick={onAddField}>
            <Plus />
            Add a question
          </Button>

          {/* A removed optional system field can only come back as itself: a
              custom field may not wear a reserved key, so without this the
              phone question is gone for the life of the form. */}
          {restorable.length > 0 && (
            <NativeSelect
              aria-label="Put back a fixed question"
              className="h-8 w-auto text-sm"
              value=""
              onChange={(event) => event.target.value && onRestoreField(event.target.value)}
            >
              <option value="">Put back…</option>
              {restorable.map((spec) => (
                <option key={spec.key} value={spec.key}>
                  {spec.label}
                </option>
              ))}
            </NativeSelect>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
