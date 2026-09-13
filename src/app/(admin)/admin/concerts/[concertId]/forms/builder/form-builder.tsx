'use client';

import { useCallback, useEffect, useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Braces, Eye, Plus, Save } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '@/components/ui/resizable';
import { Spinner } from '@/components/ui/spinner';
import { FormRenderer } from '@/components/forms/form-renderer';
import { emptyAnswers, type FormAnswers } from '@/lib/forms/answers';
import { COPY_TOKENS, type CopyValues } from '@/lib/forms/copy';
import { parseFormSchema, type FormSchema } from '@/lib/forms/schema';
import { BlockEditor } from './block-editor';
import {
  addCustomBlock,
  addField,
  deleteBlock,
  deleteField,
  moveBlock,
  moveField,
  reorderBlock,
  restoreSystemField,
  updateBlockCopy,
  updateField,
  type FieldPatch,
} from './operations';
import { saveFormSchemaAction } from '../actions';

/**
 * The builder, beside the form it builds (spec/v2.md §8.2).
 *
 * **The preview is `K`'s renderer, not a second one.** It is the same component
 * a stranger fills in, driven from the same JSON, so "what the admin sees" and
 * "what the form is" cannot drift — which is the whole argument for one generic
 * renderer (`surfaces.md` §15.2). It runs `disabled`, and with
 * `showCopyWarnings` on, because an unresolved `{{token}}` renders as an empty
 * space that an admin can fix and a registrant cannot.
 *
 * **The answers reset when the shape changes.** `K` is explicit that the way to
 * do that is a React `key`; here it is keyed on the block and field structure
 * rather than on `schema_version`, because the version only moves on save and
 * an admin adding a question wants to see it immediately. Typing in a label
 * does not reset anything, so a half-filled preview survives ordinary editing.
 *
 * **The parse runs on every keystroke and the save runs it again.** This one is
 * advisory — it turns the contract's message into something an admin sees while
 * they are still looking at the field that caused it — and `saveFormSchemaAction`
 * is the boundary that actually decides. A builder that trusted its own
 * validation would be a second implementation of decisions 35 and 37.
 */

export function FormBuilder({
  concertId,
  formId,
  initialSchema,
  limits,
  copy,
  readOnly,
  canRekey,
}: {
  concertId: number;
  formId: number;
  initialSchema: FormSchema;
  limits: Readonly<Record<string, number>>;
  copy: CopyValues;
  /** A closed form still renders, so its questions can be read and copied forward. */
  readOnly?: boolean;
  /**
   * Whether a custom question's key may still follow its label — true only on a
   * `DRAFT`, where nothing can yet have been answered under the old one.
   */
  canRekey?: boolean;
}) {
  const [schema, setSchema] = useState<FormSchema>(initialSchema);
  const [saved, setSaved] = useState<FormSchema>(initialSchema);
  const [dragging, setDragging] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  const dirty = useMemo(
    () => JSON.stringify(schema) !== JSON.stringify(saved),
    [schema, saved],
  );

  /** Advisory: the same contract, run early so a mistake is visible in place. */
  const parsed = useMemo(() => parseFormSchema(schema), [schema]);

  /**
   * The preview's reset key: block ids, field keys and types.
   *
   * Deliberately not the whole schema — that would clear a half-filled preview
   * on every keystroke in a label — and deliberately not `schema_version`,
   * which only moves on save.
   */
  const shapeKey = useMemo(
    () =>
      schema.blocks
        .map((block) => {
          const fields = 'guest_fields' in block ? block.guest_fields : block.fields;
          return `${block.id}:${fields.map((field) => `${field.key}/${field.type}`).join(',')}`;
        })
        .join('|'),
    [schema],
  );

  const [answers, setAnswers] = useState<FormAnswers>(() => emptyAnswers(schema, limits));

  /**
   * Whether there is room for the split.
   *
   * Starts true because this console is web-first and the server renders no
   * `matchMedia`: a first paint that assumed a phone would rearrange itself
   * under the reader on every desktop load, which is the more common case by
   * far (`surfaces.md` §15.1).
   */
  const [wide, setWide] = useState(true);
  useEffect(() => {
    const query = window.matchMedia('(min-width: 1024px)');
    const sync = () => setWide(query.matches);
    sync();
    query.addEventListener('change', sync);
    return () => query.removeEventListener('change', sync);
  }, []);

  const edit = useCallback((next: FormSchema) => {
    setSchema(next);
    setMessage(null);
  }, []);

  function save() {
    setError(null);
    setMessage(null);
    const candidate = schema;

    startTransition(async () => {
      const data = new FormData();
      data.set('schema', JSON.stringify(candidate));
      const result = await saveFormSchemaAction(concertId, formId, { error: null }, data);
      if (result.error) {
        setError(result.error);
        return;
      }
      setSaved(candidate);
      setMessage(result.message ?? 'Saved.');
      router.refresh();
    });
  }

  const preview = (
    <div className="bg-muted/30 h-full overflow-y-auto p-4">
      <div className="mx-auto max-w-xl">
        <p className="text-muted-foreground mb-3 flex items-center gap-2 text-xs font-medium tracking-wide uppercase">
          <Eye className="size-3.5" />
          Live preview
        </p>
        {parsed.ok ? (
          <div className="bg-background rounded-lg border p-4 sm:p-6">
            <FormRenderer
              key={shapeKey}
              schema={parsed.schema}
              limits={limits}
              copy={copy}
              value={answers}
              onValueChange={setAnswers}
              disabled
              showCopyWarnings
            />
          </div>
        ) : (
          <Alert variant="destructive">
            <AlertTitle>This form cannot be drawn yet</AlertTitle>
            <AlertDescription className="whitespace-pre-wrap">{parsed.message}</AlertDescription>
          </Alert>
        )}
      </div>
    </div>
  );

  const editor = (
    <div className="flex h-full flex-col gap-4 overflow-y-auto p-4">
      {/* Said once, above the sections, rather than under every copy box. Copy
          interpolates resolved settings so a form's own text never hardcodes a
          number either (spec/README.md §2.1) — but repeating the token list
          under all five boxes buries the questions they sit between. */}
      {!readOnly && (
        <details className="bg-muted/40 rounded-md border px-3 py-2 text-sm">
          <summary className="text-muted-foreground flex cursor-pointer items-center gap-2">
            <Braces className="size-3.5" />
            Write a number as a token, and the form fills it in
          </summary>
          <dl className="text-muted-foreground mt-2 grid gap-1 sm:grid-cols-2">
            {COPY_TOKENS.map((entry) => (
              <div key={entry.token}>
                <dt className="inline">
                  <code className="text-xs">{`{{${entry.token}}}`}</code>
                </dt>
                <dd className="inline"> — {entry.description}</dd>
              </div>
            ))}
          </dl>
        </details>
      )}

      {readOnly ? (
        <Alert>
          <AlertTitle>This form is closed</AlertTitle>
          <AlertDescription>
            Its questions are on the right, as they were answered. Editing them now
            would change what those answers mean, so the controls are withheld — start
            a new round instead, which copies these questions to a form of its own.
          </AlertDescription>
        </Alert>
      ) : (
        schema.blocks.map((block, index) => (
        <BlockEditor
          key={block.id}
          schema={schema}
          block={block}
          index={index}
          isDragging={dragging === index}
          onDragStart={() => setDragging(index)}
          onDragOver={(event) => {
            if (dragging === null) return;
            // Without this the drop never fires: the default handling of
            // `dragover` is to refuse the drop.
            event.preventDefault();
          }}
          onDrop={() => {
            if (dragging === null || dragging === index) return;
            edit(reorderBlock(schema, dragging, index));
            setDragging(null);
          }}
          onDragEnd={() => setDragging(null)}
          onMove={(direction) => edit(moveBlock(schema, index, direction))}
          onDelete={() => edit(deleteBlock(schema, index))}
          onCopyChange={(patch) => edit(updateBlockCopy(schema, index, patch))}
          onAddField={() => edit(addField(schema, index))}
          onRestoreField={(key) => edit(restoreSystemField(schema, index, key))}
          onFieldChange={(fieldIndex: number, patch: FieldPatch) =>
            edit(updateField(schema, index, fieldIndex, patch, canRekey))
          }
          onFieldMove={(fieldIndex: number, direction: -1 | 1) =>
            edit(moveField(schema, index, fieldIndex, direction))
          }
          onFieldDelete={(fieldIndex: number) => edit(deleteField(schema, index, fieldIndex))}
        />
        ))
      )}

      {!readOnly && (
        <Button
          type="button"
          variant="outline"
          className="self-start"
          onClick={() => edit(addCustomBlock(schema))}
        >
          <Plus />
          Add a section
        </Button>
      )}
    </div>
  );

  return (
    <div className="flex flex-col gap-3">
      <div className={readOnly ? 'hidden' : 'flex flex-wrap items-center justify-between gap-3'}>
        <div className="text-muted-foreground text-sm">
          {dirty ? 'Unsaved changes' : 'All changes saved'}
          {message && !dirty && <span className="text-foreground"> · {message}</span>}
        </div>
        <Button type="button" onClick={save} disabled={isPending || !dirty || !parsed.ok}>
          {isPending ? <Spinner /> : <Save />}
          {isPending ? 'Saving…' : 'Save questions'}
        </Button>
      </div>

      {error && (
        <Alert variant="destructive" role="alert">
          <AlertTitle>That schema was refused</AlertTitle>
          <AlertDescription className="whitespace-pre-wrap">{error}</AlertDescription>
        </Alert>
      )}

      {/* Web-first: the split is the point of the screen, so it is a real
          resizable pair on a wide viewport and two stacked panes below, rather
          than a preview hidden behind a tab (`surfaces.md` §15.1).

          **Chosen at runtime rather than with `lg:hidden`.** Rendering both and
          hiding one would put two copies of every control in the document,
          which duplicates the `id`s the field labels point at — a click on a
          label would focus the copy in the hidden pane. */}
      {wide ? (
        <ResizablePanelGroup
          orientation="horizontal"
          className="flex min-h-[70vh] rounded-lg border"
        >
          <ResizablePanel defaultSize="58%" minSize="30%">
            {editor}
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel defaultSize="42%" minSize="25%">
            {preview}
          </ResizablePanel>
        </ResizablePanelGroup>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="rounded-lg border">{editor}</div>
          <div className="rounded-lg border">{preview}</div>
        </div>
      )}
    </div>
  );
}
