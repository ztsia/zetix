'use client';

import { useMemo, useState, useSyncExternalStore } from 'react';
import { Eye, PencilLine } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { RichText } from '@/components/forms/rich-text';
import { FormRenderer, hasRequiredQuestion } from '@/components/forms/form-renderer';
import { FormHeaderCard } from '@/components/forms/form-surface';
import { emptyAnswers, type FormAnswers } from '@/lib/forms/answers';
import type { CopyValues } from '@/lib/forms/copy';
import { parseFormSchema, type FormSchema } from '@/lib/forms/schema';
import { PREVIEW_DRAFT_KEY } from '@/lib/forms/preview-draft';

/**
 * The form as a stranger meets it, driven either by what is saved or by what is
 * on the builder's screen right now.
 *
 * **The draft handoff is `localStorage`, read on the client only.** The builder
 * writes the schema it is currently showing under a per-form key immediately
 * before opening this tab, so "preview" means the questions the admin is
 * looking at rather than the ones they last pressed Save on — which is the
 * whole reason to open a preview before saving.
 *
 * `localStorage` rather than `sessionStorage` because a new tab does not
 * reliably inherit the opener's session store, and rather than a query
 * parameter because a schema does not fit in a URL. It is read once and left
 * in place: re-opening the same preview after a reload should show the same
 * thing, and the builder overwrites the key on every press.
 *
 * **Everything is live except the submit.** The controls work, conditions fire,
 * repeaters add rows — so the admin can actually walk the form the way a
 * reader will. The button at the bottom is inert and says why. There is no
 * action behind this page at all, so nothing can be written by pressing it.
 */
export function FormPreview({
  formId,
  concertId,
  title,
  description,
  schema: savedSchema,
  limits,
  copy,
  status,
}: {
  formId: number;
  concertId: number;
  title: string;
  description: string | null;
  schema: FormSchema;
  limits: Readonly<Record<string, number>>;
  copy: CopyValues;
  status: string;
}) {
  /**
   * **`localStorage` read through `useSyncExternalStore`, not an effect.**
   *
   * The behaviour is the one the comment above always described — the server
   * snapshot is `null`, so the first paint is the saved form and never a flash
   * of the wrong questions — but expressing it as "set state in an effect"
   * is the pattern React 19 now flags, because it is a second render scheduled
   * after paint rather than part of the one that hydrates.
   *
   * Reading browser storage is exactly what this hook is for: `getServerSnapshot`
   * covers SSR and hydration, `getSnapshot` runs only on the client, and the
   * value is a string so React's own `Object.is` check settles it without a
   * cache. Nothing subscribes — the builder writes the key before opening this
   * tab and never while it is open — so the subscribe function is a no-op.
   */
  const stored = useSyncExternalStore(
    subscribeToNothing,
    () => {
      try {
        return window.localStorage.getItem(PREVIEW_DRAFT_KEY(formId));
      } catch {
        // Storage can be unavailable — private windows, blocked site data. The
        // saved schema is already on the page, so there is nothing to recover.
        return null;
      }
    },
    () => null,
  );

  /**
   * The contract judges it, exactly as the server would. A draft that does not
   * parse is ignored in favour of the saved schema rather than crashing the tab
   * the admin opened to look at it.
   */
  const draft = useMemo(() => {
    if (!stored) return null;
    try {
      const parsed = parseFormSchema(JSON.parse(stored));
      return parsed.ok ? parsed.schema : null;
    } catch {
      return null;
    }
  }, [stored]);

  const schema = draft ?? savedSchema;
  const [answers, setAnswers] = useState<FormAnswers>(() => emptyAnswers(savedSchema, limits));

  /** Reset the answers when the questions change under them. */
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

  /**
   * **Adjusted during render, not in an effect** — React's documented way to
   * reset state when the thing it derives from changes.
   *
   * `shapeKey` is the trigger on purpose: typing in a label must not wipe a
   * half-filled preview, the same rule the builder's own preview follows. Only
   * adding, removing, reordering or retyping a question does.
   *
   * Doing it here rather than in an effect means the re-render happens before
   * paint, so the stale answers are never shown for a frame.
   */
  const [renderedShape, setRenderedShape] = useState(shapeKey);
  if (renderedShape !== shapeKey) {
    setRenderedShape(shapeKey);
    setAnswers(emptyAnswers(schema, limits));
  }

  return (
    <div className="flex flex-col gap-3">
      {/*
        A banner, not a watermark. It has to be unmissable — this page looks
        exactly like the real form, which is the point, and an admin who forgot
        which tab they were in could otherwise believe they had a live form
        open. It scrolls away with the page rather than sticking, because a
        fixed bar would change the layout it exists to show faithfully.
      */}
      <div className="bg-form-card border-form-accent flex flex-wrap items-center justify-between gap-3 rounded-lg border border-dashed px-4 py-3">
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Eye className="size-4 shrink-0" />
          <span>
            <strong className="text-foreground">Preview</strong> — this is how the form
            looks on the link.{' '}
            {draft
              ? 'Showing your unsaved changes.'
              : status === 'DRAFT'
                ? 'This form is still a draft, so the real link is not live yet.'
                : 'Showing the saved questions.'}
          </span>
        </p>
        <Button
          variant="outline"
          size="sm"
          nativeButton={false}
          render={<a href={`/admin/concerts/${concertId}/forms/${formId}`} />}
        >
          <PencilLine />
          Back to editing
        </Button>
      </div>

      <FormHeaderCard
        title={title}
        description={description ? <RichText markdown={description} /> : null}
        requiredNote={hasRequiredQuestion(schema)}
      />

      <FormRenderer
        schema={schema}
        limits={limits}
        copy={copy}
        value={answers}
        onValueChange={setAnswers}
      />

      <div className="mt-1 flex items-center justify-between gap-3 pb-6">
        <div className="flex flex-col gap-1">
          <Button type="button" disabled className="self-start">
            Submit
          </Button>
          <p className="text-muted-foreground text-xs">Nothing is sent from a preview.</p>
        </div>
        <Button
          type="button"
          variant="ghost"
          onClick={() => setAnswers(emptyAnswers(schema, limits))}
          className="self-start"
        >
          Clear form
        </Button>
      </div>
    </div>
  );
}

/**
 * `useSyncExternalStore` requires a subscribe function, and there is genuinely
 * nothing to subscribe to: the builder writes the draft key before opening this
 * tab, never while it is open. Defined at module scope so its identity is
 * stable — an inline one would resubscribe on every render.
 */
function subscribeToNothing(): () => void {
  return () => {};
}
