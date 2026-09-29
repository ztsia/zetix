'use client';

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Braces, CirclePlus, Rows2, Save } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { RichText } from '@/components/forms/rich-text';
import { COPY_TOKENS, type CopyValues } from '@/lib/forms/copy';
import { PREVIEW_DRAFT_KEY } from '@/lib/forms/preview-draft';
import { blockFields, isRepeaterType, parseFormSchema, type FormSchema } from '@/lib/forms/schema';
import { cn } from '@/lib/utils';
import { saveFormHeaderAction, saveFormSchemaAction } from '../actions';
import {
  addCustomBlock,
  addField,
  conditionSources,
  deleteBlock,
  deleteField,
  duplicateField,
  isCustomBlock,
  moveBlock,
  moveField,
  reorderBlock,
  reorderField,
  restorableSystemFields,
  restoreSystemField,
  updateBlockCopy,
  updateField,
} from './operations';
import { QuestionCard } from './question-card';
import { SectionCard } from './section-card';
import { AdminOnly, useCanEdit } from '@/components/auth/role';

/**
 * The builder, drawn as Google Forms draws its editor (spec/v2.md §8.2).
 *
 * A column of cards on the form's tinted canvas: the header card with the
 * title and introduction, then each section's card with its questions under
 * it. One card is open at a time — the one with the blue bar — and every other
 * card shows its question as a registrant will see it, drawn by the public
 * form's own field renderer. That is the live preview §8.2.2b asks for, in the
 * place Google Forms puts it: the questions themselves, not a second pane
 * beside them. `/preview/{formId}` remains the preview of the link.
 *
 * Beside the column floats Google Forms' toolbar — add a question, add a
 * section — which acts at the open card.
 *
 * **The parse runs on every keystroke and the save runs it again.** This one is
 * advisory — it turns the contract's message into something an admin sees while
 * they are still looking at the question that caused it — and
 * `saveFormSchemaAction` is the boundary that decides. A builder that trusted
 * its own validation would be a second implementation of decisions 35 and 37.
 *
 * **Saving stays explicit.** Google Forms saves as you type; this does not,
 * because a save here bumps `schema_version` and every response pins the version
 * it answered (§8.2.4). A version per keystroke on a live form would bury the
 * history that pinning exists to keep readable.
 */

type Active =
  | { kind: 'header' }
  | { kind: 'block'; block: number }
  | { kind: 'field'; block: number; field: number };

type Drag = { kind: 'block'; block: number } | { kind: 'field'; block: number; field: number };

/** The element id of a card, for scrolling a new one into view. */
const blockDomId = (id: string) => `builder-section-${id}`;
const fieldDomId = (blockId: string, index: number) => `builder-q-${blockId}-${index}`;

export function FormBuilder({
  concertId,
  formId,
  initialSchema,
  initialTitle,
  initialDescription,
  copy,
  readOnly: closed,
  canRekey,
}: {
  concertId: number;
  formId: number;
  initialSchema: FormSchema;
  initialTitle: string;
  initialDescription: string;
  /** Resolved `{{token}}` values, so a section's copy reads as it will on the form. */
  copy: CopyValues;
  /** A closed form still renders, so its questions can be read and copied forward. */
  readOnly?: boolean;
  /**
   * Whether a custom question's key may still follow its label — true only on a
   * `DRAFT`, where nothing can yet have been answered under the old one.
   */
  canRekey?: boolean;
}) {
  // A viewer reads the questions as a closed form shows them: no controls to
  // type into and then find no Save for (spec/v3.md §28).
  const canEdit = useCanEdit();
  const readOnly = Boolean(closed) || !canEdit;
  const [schema, setSchema] = useState<FormSchema>(initialSchema);
  const [saved, setSaved] = useState<FormSchema>(initialSchema);
  const [title, setTitle] = useState(initialTitle);
  const [description, setDescription] = useState(initialDescription);
  const [savedHeader, setSavedHeader] = useState({
    title: initialTitle,
    description: initialDescription,
  });
  const [active, setActive] = useState<Active | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [over, setOver] = useState<Drag | null>(null);
  /** A card to bring into view after the next render — a ref, since it drives no render of its own. */
  const scrollTarget = useRef<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  const schemaDirty = useMemo(
    () => JSON.stringify(schema) !== JSON.stringify(saved),
    [schema, saved],
  );
  const headerDirty = title !== savedHeader.title || description !== savedHeader.description;
  const dirty = schemaDirty || headerDirty;

  /** Advisory: the same contract, run early so a mistake is visible in place. */
  const parsed = useMemo(() => parseFormSchema(schema), [schema]);

  /**
   * The unsaved questions, for `/preview/{formId}` (§8.2.2b).
   *
   * Written whenever there is a draft that parses and removed whenever there is
   * not — including on first load, when what is on screen is what is saved — so
   * the preview button in the top bar opens the questions on screen without
   * this component having to own that button. A draft left over from a tab that
   * was closed without saving is cleared the next time the builder opens, rather
   * than shown to an admin who has since moved on.
   */
  useEffect(() => {
    try {
      if (schemaDirty && parsed.ok) {
        window.localStorage.setItem(PREVIEW_DRAFT_KEY(formId), JSON.stringify(parsed.schema));
      } else {
        window.localStorage.removeItem(PREVIEW_DRAFT_KEY(formId));
      }
    } catch {
      // Storage can be full or blocked. The preview then shows the saved form
      // and says so, which is still useful.
    }
  }, [formId, schemaDirty, parsed]);

  /** Leaving with unsaved changes asks first — there is no autosave to fall back on. */
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  /** A question or section just added is scrolled to, as Google Forms does. */
  useEffect(() => {
    if (!scrollTarget.current) return;
    document
      .getElementById(scrollTarget.current)
      ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    scrollTarget.current = null;
  });

  const edit = useCallback((next: FormSchema) => {
    setSchema(next);
    setMessage(null);
  }, []);

  function save() {
    setError(null);
    setMessage(null);
    const candidate = schema;
    const header = { title: title.trim(), description };

    startTransition(async () => {
      const messages: string[] = [];

      // The questions first. They are what the contract can refuse, and a
      // refusal should leave nothing half-saved — the title alone written and
      // the questions not is a save that looks done and is not.
      if (schemaDirty) {
        const data = new FormData();
        data.set('schema', JSON.stringify(candidate));
        const result = await saveFormSchemaAction(concertId, formId, { error: null }, data);
        if (result.error) {
          setError(result.error);
          return;
        }
        setSaved(candidate);
        if (result.message) messages.push(result.message);
      }

      if (headerDirty) {
        const data = new FormData();
        data.set('title', header.title);
        data.set('descriptionMd', header.description);
        const result = await saveFormHeaderAction(concertId, formId, { error: null }, data);
        if (result.error) {
          setError(result.error);
          return;
        }
        setSavedHeader({ title: header.title, description: header.description });
        setTitle(header.title);
      }

      setMessage(messages.join(' ') || 'Saved.');
      router.refresh();
    });
  }

  // --- the toolbar's two actions, at the open card ---------------------------

  /**
   * Where "Add question" puts the new one: after the open question; at the top
   * of the open section; otherwise at the end of the last section that is not a
   * repeater — a question added to the party repeater would be asked once per
   * guest, which is rarely what "add a question" means.
   */
  function addQuestion() {
    let blockIndex: number;
    let after: number | undefined;
    if (active?.kind === 'field') {
      blockIndex = active.block;
      after = active.field;
    } else if (active?.kind === 'block') {
      blockIndex = active.block;
      after = -1;
    } else {
      const flat = schema.blocks
        .map((b, i) => ({ b, i }))
        .filter(({ b }) => !isRepeaterType(b.type));
      blockIndex = flat.at(-1)?.i ?? schema.blocks.length - 1;
    }
    const block = schema.blocks[blockIndex];
    if (!block) return;

    const next = addField(schema, blockIndex, 'Untitled question', after);
    const at = after === undefined ? blockFields(block).length : after + 1;
    edit(next);
    setActive({ kind: 'field', block: blockIndex, field: at });
    scrollTarget.current = fieldDomId(block.id, at);
  }

  function addSection() {
    const next = addCustomBlock(schema, 'Untitled section');
    const index = next.blocks.length - 1;
    edit(next);
    setActive({ kind: 'block', block: index });
    scrollTarget.current = blockDomId(next.blocks[index].id);
  }

  // --- drag and drop -----------------------------------------------------------

  function dropOn(target: Drag) {
    if (!drag) return;
    if (drag.kind === 'field' && target.kind === 'field' && drag.block === target.block) {
      edit(reorderField(schema, drag.block, drag.field, target.field));
      setActive({ kind: 'field', block: target.block, field: target.field });
    } else if (drag.kind === 'block' && target.kind === 'block') {
      edit(reorderBlock(schema, drag.block, target.block));
      setActive(null);
    }
    setDrag(null);
    setOver(null);
  }

  /** Whether a drag may land here: questions within their own section, sections among sections. */
  function accepts(target: Drag): boolean {
    if (!drag) return false;
    if (drag.kind === 'field') return target.kind === 'field' && target.block === drag.block;
    return target.kind === 'block' && isCustomBlock(schema.blocks[target.block]);
  }

  function dragProps(target: Drag, self: boolean) {
    const same = (a: Drag | null) =>
      a !== null &&
      a.kind === target.kind &&
      a.block === target.block &&
      (a.kind === 'block' || (target.kind === 'field' && a.field === target.field));
    return {
      onDragStart: () => setDrag(target),
      onDragEnd: () => {
        setDrag(null);
        setOver(null);
      },
      onDragOver: (event: React.DragEvent) => {
        if (!accepts(target)) return;
        // Without this the drop never fires: the default handling of
        // `dragover` is to refuse it.
        event.preventDefault();
        if (!same(over)) setOver(target);
      },
      onDrop: () => dropOn(target),
      isDragging: self && same(drag),
      isDropTarget: !same(drag) && same(over) && accepts(target),
    };
  }

  const pendingBlock = pendingDelete === null ? null : schema.blocks[pendingDelete];

  return (
    <div className="flex flex-col gap-3">
      {!readOnly && (
        <div className="bg-background/95 supports-[backdrop-filter]:bg-background/80 sticky top-2 z-20 mx-auto flex w-full max-w-[770px] flex-wrap items-center justify-between gap-3 rounded-lg border px-4 py-2 shadow-sm backdrop-blur">
          <p className="text-muted-foreground text-sm" role="status">
            {isPending
              ? 'Saving…'
              : dirty
                ? 'Unsaved changes'
                : message
                  ? message
                  : 'All changes saved'}
          </p>
          <div className="flex items-center gap-1">
            <TokenHelp />
            <AdminOnly>
              <Button
                type="button"
                onClick={save}
                disabled={isPending || !dirty || !parsed.ok || title.trim() === ''}
              >
                {isPending ? <Spinner /> : <Save />}
                {isPending ? 'Saving…' : 'Save'}
              </Button>
            </AdminOnly>
          </div>
        </div>
      )}

      {error && (
        <Alert variant="destructive" role="alert" className="mx-auto max-w-[770px]">
          <AlertTitle>That was not saved</AlertTitle>
          <AlertDescription className="whitespace-pre-wrap">{error}</AlertDescription>
        </Alert>
      )}

      {!parsed.ok && (
        <Alert variant="destructive" className="mx-auto max-w-[770px]">
          <AlertTitle>This form cannot be saved yet</AlertTitle>
          <AlertDescription className="whitespace-pre-wrap">{parsed.message}</AlertDescription>
        </Alert>
      )}

      {closed && (
        <Alert className="mx-auto max-w-[770px]">
          <AlertTitle>This form is closed</AlertTitle>
          <AlertDescription>
            Its questions are below, as they were answered. Editing them now would change what those
            answers mean, so the controls are withheld — start a new round instead, which copies
            these questions to a form of its own.
          </AlertDescription>
        </Alert>
      )}

      <div className="mx-auto grid w-full max-w-[834px] gap-4 lg:grid-cols-[minmax(0,1fr)_48px]">
        <div className="flex min-w-0 flex-col gap-3">
          <HeaderCard
            title={title}
            description={description}
            active={active?.kind === 'header'}
            readOnly={Boolean(readOnly)}
            onActivate={() => setActive({ kind: 'header' })}
            onTitle={(next) => {
              setTitle(next);
              setMessage(null);
            }}
            onDescription={(next) => {
              setDescription(next);
              setMessage(null);
            }}
          />

          {schema.blocks.map((block, blockIndex) => {
            const fields = blockFields(block);
            const neighbours = schema.blocks;
            return (
              <div key={block.id} className="flex flex-col gap-3">
                <SectionCard
                  block={block}
                  copy={copy}
                  index={blockIndex}
                  total={schema.blocks.length}
                  domId={blockDomId(block.id)}
                  active={active?.kind === 'block' && active.block === blockIndex}
                  readOnly={Boolean(readOnly)}
                  canMoveUp={
                    isCustomBlock(block) &&
                    Boolean(neighbours[blockIndex - 1]) &&
                    isCustomBlock(neighbours[blockIndex - 1])
                  }
                  canMoveDown={isCustomBlock(block) && Boolean(neighbours[blockIndex + 1])}
                  restorable={restorableSystemFields(block)}
                  onActivate={() => setActive({ kind: 'block', block: blockIndex })}
                  onCopyChange={(patch) => edit(updateBlockCopy(schema, blockIndex, patch))}
                  onMove={(direction) => {
                    const next = moveBlock(schema, blockIndex, direction);
                    edit(next);
                    if (next !== schema)
                      setActive({ kind: 'block', block: blockIndex + direction });
                  }}
                  onDelete={() => {
                    // Google Forms asks before a section takes its questions
                    // with it; an empty one just goes.
                    if (fields.length > 0) setPendingDelete(blockIndex);
                    else {
                      edit(deleteBlock(schema, blockIndex));
                      setActive(null);
                    }
                  }}
                  onRestore={(key) => edit(restoreSystemField(schema, blockIndex, key))}
                  drag={dragProps({ kind: 'block', block: blockIndex }, true)}
                />

                {fields.length === 0 && (
                  <p className="text-muted-foreground rounded-lg border border-dashed border-form-line px-6 py-5 text-center text-sm">
                    No questions in this section yet.
                    {!readOnly && ' Open it and use + to add one.'}
                  </p>
                )}

                {fields.map((field, fieldIndex) => (
                  <QuestionCard
                    key={`${fieldIndex}-${field.key}`}
                    block={block}
                    field={field}
                    domId={fieldDomId(block.id, fieldIndex)}
                    active={
                      active?.kind === 'field' &&
                      active.block === blockIndex &&
                      active.field === fieldIndex
                    }
                    readOnly={Boolean(readOnly)}
                    sources={conditionSources(schema, blockIndex, fieldIndex)}
                    canMoveUp={fieldIndex > 0}
                    canMoveDown={fieldIndex < fields.length - 1}
                    onActivate={() =>
                      setActive({ kind: 'field', block: blockIndex, field: fieldIndex })
                    }
                    onChange={(patch) =>
                      edit(updateField(schema, blockIndex, fieldIndex, patch, canRekey))
                    }
                    onDelete={() => {
                      edit(deleteField(schema, blockIndex, fieldIndex));
                      // The open card moves to the one above, as on Google Forms,
                      // so the toolbar still has somewhere to act.
                      setActive(
                        fieldIndex > 0
                          ? { kind: 'field', block: blockIndex, field: fieldIndex - 1 }
                          : { kind: 'block', block: blockIndex },
                      );
                    }}
                    onDuplicate={() => {
                      edit(duplicateField(schema, blockIndex, fieldIndex));
                      setActive({ kind: 'field', block: blockIndex, field: fieldIndex + 1 });
                      scrollTarget.current = fieldDomId(block.id, fieldIndex + 1);
                    }}
                    onMove={(direction) => {
                      edit(moveField(schema, blockIndex, fieldIndex, direction));
                      setActive({
                        kind: 'field',
                        block: blockIndex,
                        field: fieldIndex + direction,
                      });
                    }}
                    drag={dragProps({ kind: 'field', block: blockIndex, field: fieldIndex }, true)}
                  />
                ))}
              </div>
            );
          })}

          {!readOnly && (
            <div className="sticky bottom-3 z-20 flex justify-center lg:hidden">
              <Toolbar
                orientation="horizontal"
                onAddQuestion={addQuestion}
                onAddSection={addSection}
              />
            </div>
          )}
        </div>

        {!readOnly && (
          <aside className="hidden lg:block">
            <div className="sticky top-20">
              <Toolbar
                orientation="vertical"
                onAddQuestion={addQuestion}
                onAddSection={addSection}
              />
            </div>
          </aside>
        )}
      </div>

      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
      >
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete questions and section?</AlertDialogTitle>
            <AlertDialogDescription>
              Deleting &ldquo;{pendingBlock?.title}&rdquo; will also delete the{' '}
              {pendingBlock ? blockFields(pendingBlock).length : 0} question
              {pendingBlock && blockFields(pendingBlock).length === 1 ? '' : 's'} in it. Nothing is
              saved until you press Save.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (pendingDelete !== null) edit(deleteBlock(schema, pendingDelete));
                setPendingDelete(null);
                setActive(null);
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/**
 * The card at the top, edited in place: the title in 32px on an underline, the
 * introduction under it — Google Forms' header card, with its accent band.
 */
function HeaderCard({
  title,
  description,
  active,
  readOnly,
  onActivate,
  onTitle,
  onDescription,
}: {
  title: string;
  description: string;
  active: boolean;
  readOnly: boolean;
  onActivate: () => void;
  onTitle: (next: string) => void;
  onDescription: (next: string) => void;
}) {
  const editing = active && !readOnly;

  return (
    <div
      className={cn(
        'bg-form-card text-card-foreground relative overflow-hidden rounded-lg border border-form-line',
        editing && 'shadow-md',
      )}
    >
      <div className="bg-form-accent h-2.5" aria-hidden />
      {editing && <div className="bg-form-focus absolute inset-y-0 left-0 w-1.5" aria-hidden />}
      {!editing && !readOnly && (
        <button
          type="button"
          aria-label="Edit the form's title and description"
          onClick={onActivate}
          className="focus-visible:ring-form-focus absolute inset-0 z-10 cursor-pointer rounded-lg focus-visible:ring-2 focus-visible:outline-none"
        />
      )}
      <div className="flex flex-col gap-3 px-6 pt-5 pb-5">
        {editing ? (
          <>
            <Input
              aria-label="Form title"
              value={title}
              placeholder="Untitled form"
              autoFocus
              aria-invalid={title.trim() === '' || undefined}
              onChange={(event) => onTitle(event.target.value)}
              className="border-form-line focus-visible:border-form-accent h-14 rounded-none border-0 border-b bg-transparent px-0 text-[32px] leading-10 shadow-none focus-visible:border-b-2 focus-visible:ring-0 md:text-[32px] dark:bg-transparent"
            />
            <Textarea
              aria-label="Form description"
              value={description}
              placeholder="Form description"
              rows={1}
              onChange={(event) => onDescription(event.target.value)}
              className="border-form-line focus-visible:border-form-accent field-sizing-content min-h-9 resize-none rounded-none border-0 border-b bg-transparent px-0 py-2 text-sm shadow-none focus-visible:border-b-2 focus-visible:ring-0 dark:bg-transparent"
            />
            <p className="text-muted-foreground text-xs">
              **Bold**, *italic*, [links](https://example.org) and lists work in every description.
            </p>
          </>
        ) : (
          <>
            <h2 className="text-[28px] leading-9 sm:text-[32px] sm:leading-10">
              {title || 'Untitled form'}
            </h2>
            {description ? (
              <RichText markdown={description} className="text-sm leading-6" />
            ) : (
              !readOnly && <p className="text-muted-foreground text-sm">Form description</p>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** Google Forms' floating toolbar: add a question, add a section. */
function Toolbar({
  orientation,
  onAddQuestion,
  onAddSection,
}: {
  orientation: 'vertical' | 'horizontal';
  onAddQuestion: () => void;
  onAddSection: () => void;
}) {
  const side = orientation === 'vertical' ? 'right' : 'top';
  return (
    <div
      role="toolbar"
      aria-label="Add to the form"
      aria-orientation={orientation}
      className={cn(
        'bg-form-card flex gap-1 rounded-lg border border-form-line p-1 shadow-md',
        orientation === 'vertical' ? 'flex-col' : 'flex-row',
      )}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon-lg"
              aria-label="Add question"
              onClick={onAddQuestion}
            />
          }
        >
          <CirclePlus />
        </TooltipTrigger>
        <TooltipContent side={side}>Add question</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon-lg"
              aria-label="Add section"
              onClick={onAddSection}
            />
          }
        >
          <Rows2 />
        </TooltipTrigger>
        <TooltipContent side={side}>Add section</TooltipContent>
      </Tooltip>
    </div>
  );
}

/**
 * The copy tokens, behind one button in the save bar rather than under every
 * text box. A form's copy interpolates resolved settings so its own words never
 * hardcode a number either (spec/README.md §2.1).
 */
function TokenHelp() {
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button type="button" variant="ghost" size="sm" className="text-muted-foreground" />
        }
      >
        <Braces />
        Tokens
      </PopoverTrigger>
      <PopoverContent align="end" className="w-96">
        <p className="mb-2 text-sm font-medium">
          Write a number as a token, and the form fills it in
        </p>
        <dl className="text-muted-foreground grid gap-1 text-sm">
          {COPY_TOKENS.map((entry) => (
            <div key={entry.token}>
              <dt className="inline">
                <code className="text-xs">{`{{${entry.token}}}`}</code>
              </dt>
              <dd className="inline"> — {entry.description}</dd>
            </div>
          ))}
        </dl>
      </PopoverContent>
    </Popover>
  );
}
