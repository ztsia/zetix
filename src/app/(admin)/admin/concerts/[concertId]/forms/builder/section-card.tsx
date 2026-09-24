'use client';

import {
  ArrowDown,
  ArrowUp,
  EllipsisVertical,
  GripHorizontal,
  Lock,
  Trash2,
  Undo2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { RichText } from '@/components/forms/rich-text';
import { interpolateCopy, type CopyValues } from '@/lib/forms/copy';
import { isRepeaterType, type FormBlock } from '@/lib/forms/schema';
import { cn } from '@/lib/utils';
import { BLOCK_HELP, isCustomBlock } from './operations';

/**
 * A section's header in the builder — Google Forms' section card, with its
 * "Section 2 of 3" tab on top (spec/v2.md §8.2).
 *
 * **System sections come from the form's kind** and are never added, deleted
 * or moved (decision 35), so theirs has no ⋮ menu and no handle rather than
 * disabled ones; a line under the title says what the section is for. Their
 * title and copy are the admin's, like everyone else's.
 *
 * A removed optional system question — the phone number, a guest's email — can
 * only come back as itself, since a custom question may not wear a reserved
 * key; the ⋮ menu's "Put back" is how.
 */
export function SectionCard({
  block,
  copy,
  index,
  total,
  domId,
  active,
  readOnly,
  canMoveUp,
  canMoveDown,
  restorable,
  onActivate,
  onCopyChange,
  onMove,
  onDelete,
  onRestore,
  drag,
}: {
  block: FormBlock;
  /** Resolved tokens: at rest the section's copy reads as it will on the form. */
  copy: CopyValues;
  index: number;
  total: number;
  domId: string;
  active: boolean;
  readOnly: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  restorable: { key: string; label: string }[];
  onActivate: () => void;
  onCopyChange: (patch: {
    title?: string;
    description_md?: string | null;
    add_label?: string | null;
  }) => void;
  onMove: (direction: -1 | 1) => void;
  onDelete: () => void;
  onRestore: (key: string) => void;
  drag: {
    onDragStart: () => void;
    onDragEnd: () => void;
    onDragOver: (event: React.DragEvent) => void;
    onDrop: () => void;
    isDragging: boolean;
    isDropTarget: boolean;
  };
}) {
  const custom = isCustomBlock(block);
  const editing = active && !readOnly;
  const resolved = block.description_md ? interpolateCopy(block.description_md, copy) : null;

  return (
    <div
      id={domId}
      onDragOver={drag.onDragOver}
      onDrop={drag.onDrop}
      className={cn('flex flex-col', drag.isDragging && 'opacity-40')}
    >
      <div className="bg-form-accent text-form-accent-foreground self-start rounded-t-lg px-4 py-2 text-sm font-medium">
        Section {index + 1} of {total}
      </div>

      <div
        className={cn(
          'bg-form-card text-card-foreground border-t-form-accent relative overflow-hidden rounded-lg rounded-tl-none border border-t-[3px] border-form-line',
          editing && 'shadow-md',
          drag.isDropTarget && 'ring-form-focus ring-2',
        )}
      >
        {editing && <div className="bg-form-focus absolute inset-y-0 left-0 w-1.5" aria-hidden />}

        {!editing && !readOnly && (
          <button
            type="button"
            aria-label={`Edit section ${block.title}`}
            onClick={onActivate}
            className="focus-visible:ring-form-focus absolute inset-0 z-10 cursor-pointer rounded-lg focus-visible:ring-2 focus-visible:outline-none"
          />
        )}

        {editing && custom && (
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
        )}

        <div className={cn('flex flex-col gap-3 px-6', editing ? 'pt-2 pb-5' : 'py-5')}>
          {editing ? (
            <div className="flex items-start gap-2">
              <Input
                aria-label="Section title"
                value={block.title}
                placeholder="Untitled section"
                onChange={(event) => onCopyChange({ title: event.target.value })}
                className="border-form-line focus-visible:border-form-accent h-12 flex-1 rounded-none border-0 border-b bg-transparent px-0 text-2xl shadow-none focus-visible:border-b-2 focus-visible:ring-0 md:text-2xl dark:bg-transparent"
              />
              <SectionMenu
                custom={custom}
                title={block.title}
                canMoveUp={canMoveUp}
                canMoveDown={canMoveDown}
                restorable={restorable}
                onMove={onMove}
                onDelete={onDelete}
                onRestore={onRestore}
              />
            </div>
          ) : (
            <h2 className="text-xl leading-7">{block.title}</h2>
          )}

          {editing ? (
            <Textarea
              aria-label="Section description"
              value={block.description_md ?? ''}
              placeholder="Description (optional)"
              rows={1}
              onChange={(event) => onCopyChange({ description_md: event.target.value })}
              className="border-form-line focus-visible:border-form-accent field-sizing-content min-h-9 resize-none rounded-none border-0 border-b bg-transparent px-0 py-2 text-sm shadow-none focus-visible:border-b-2 focus-visible:ring-0 dark:bg-transparent"
            />
          ) : resolved ? (
            <RichText markdown={resolved.text} className="text-sm leading-6" />
          ) : null}

          {/*
            An unknown token renders as nothing on the public form, where a
            registrant cannot act on it — so the builder says so here, where the
            admin can.
          */}
          {resolved && resolved.unknown.length > 0 && (
            <p className="text-destructive text-xs">
              {resolved.unknown.map((token) => `{{${token}}}`).join(', ')} is not a token, and will
              show as nothing.
            </p>
          )}

          {editing && isRepeaterType(block.type) && (
            <div className="flex items-center gap-3">
              <span className="text-muted-foreground w-36 shrink-0 text-xs">
                &ldquo;Add another&rdquo; button
              </span>
              <Input
                aria-label="Add another button label"
                value={'add_label' in block ? (block.add_label ?? '') : ''}
                placeholder={block.type === 'GUESTS_PARTY' ? 'Add a guest' : 'Add a seat'}
                onChange={(event) => onCopyChange({ add_label: event.target.value })}
                className="border-form-line focus-visible:border-form-accent h-9 max-w-xs rounded-none border-0 border-b bg-transparent px-0 text-sm shadow-none focus-visible:border-b-2 focus-visible:ring-0 dark:bg-transparent"
              />
            </div>
          )}

          {!custom && (
            <p className="text-muted-foreground flex items-start gap-2 text-xs">
              <Lock className="mt-0.5 size-3.5 shrink-0" />
              <span>{BLOCK_HELP[block.type]}</span>
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function SectionMenu({
  custom,
  title,
  canMoveUp,
  canMoveDown,
  restorable,
  onMove,
  onDelete,
  onRestore,
}: {
  custom: boolean;
  title: string;
  canMoveUp: boolean;
  canMoveDown: boolean;
  restorable: { key: string; label: string }[];
  onMove: (direction: -1 | 1) => void;
  onDelete: () => void;
  onRestore: (key: string) => void;
}) {
  // A system section with nothing to put back has no actions at all, so it
  // gets no menu rather than an empty one.
  if (!custom && restorable.length === 0) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={`Section options for ${title}`}
          />
        }
      >
        <EllipsisVertical />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        {restorable.length > 0 && (
          <DropdownMenuGroup>
            <DropdownMenuLabel>Put back a fixed question</DropdownMenuLabel>
            {restorable.map((spec) => (
              <DropdownMenuItem key={spec.key} onClick={() => onRestore(spec.key)}>
                <Undo2 />
                {spec.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
        )}
        {custom && (
          <>
            {restorable.length > 0 && <DropdownMenuSeparator />}
            <DropdownMenuItem disabled={!canMoveUp} onClick={() => onMove(-1)}>
              <ArrowUp />
              Move section up
            </DropdownMenuItem>
            <DropdownMenuItem disabled={!canMoveDown} onClick={() => onMove(1)}>
              <ArrowDown />
              Move section down
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={onDelete}>
              <Trash2 />
              Delete section
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
