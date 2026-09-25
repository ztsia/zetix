import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { requireRole } from '@/lib/auth/guards';
import { resolveFormCopy } from '@/lib/forms/resolve-copy';
import { resolveRepeaterLimits } from '@/lib/forms/limits';
import { parseFormSchema } from '@/lib/forms/schema';
import { blankFormSchema } from '@/lib/forms/templates';
import { getFormById } from '@/lib/forms/by-id';
import { FormNotConfigured } from '../../f/[slug]/states';
import { FormPreview } from './form-preview';

export const metadata: Metadata = {
  title: 'Preview',
  robots: { index: false, follow: false },
};

/**
 * `/preview/{formId}` — the form as a stranger meets it (spec/v2.md §8.2).
 *
 * **It lives on the registration surface, not in the admin console.** The
 * builder's side-by-side preview answers "is this question right?"; this one
 * answers "what does the link I am about to send actually open?" — and the only
 * honest way to answer that is to render inside the layout the link opens: the
 * registration surface's single column, its width, its type, its theme, no
 * admin chrome anywhere (`surfaces.md` §15.2). A preview drawn inside the
 * console is a preview of the console.
 *
 * **Console-only (admin or viewer), despite the address.** It sits under `(registration)` for the
 * layout and nothing else; `requireRole` is what decides who may open it. A
 * draft form is not public, and this route reaches one by id without any of the
 * gates `/f/{slug}` applies — no `OPEN` status, no open/close window, no
 * capacity check. That is the point of a preview and exactly why it may not be
 * reachable by a stranger who guesses a number.
 *
 * **Nothing it does can be submitted.** The renderer runs live so every control
 * behaves — a scale takes a tap, a grid takes a row, a conditional question
 * appears — but the submit button is inert and says so. There is no action
 * behind this page to post to, which is a stronger guarantee than a disabled
 * button: a draft form has no response table waiting for it.
 */
export default async function FormPreviewPage({
  params,
}: {
  params: Promise<{ formId: string }>;
}) {
  await requireRole('ADMIN', 'VIEWER');

  const { formId: raw } = await params;
  const formId = Number(raw);
  if (!Number.isInteger(formId)) notFound();

  const form = await getFormById(formId);
  if (!form) notFound();

  /**
   * A schema that no longer parses still previews, from its kind's template —
   * the same choice the builder page makes, for the same reason: an admin who
   * cannot reach the screen cannot fix what is on it.
   */
  const parsed = parseFormSchema(form.schema);
  const schema = parsed.ok ? parsed.schema : blankFormSchema(form.kind);

  const [copy, limits] = await Promise.all([
    resolveFormCopy({
      segmentId: form.segmentId,
      showId: form.showId,
      concertId: form.concertId,
      timeZone: form.timeZone,
    }),
    resolveRepeaterLimits(schema, {
      segmentId: form.segmentId,
      showId: form.showId,
      concertId: form.concertId,
      // A preview is a form nobody has filled in, so no base seats are held yet.
      baseAlreadyClaimed: 0,
    }),
  ]);

  /**
   * **A cap that resolves to nothing stops the preview rather than guessing**
   * (spec/README.md §2.1) — the same refusal the builder page makes, and the
   * same one a registrant would meet, which is what the preview is for. A
   * FEEDBACK form has no repeater and no cap to miss, so it never lands here.
   */
  if (!limits.ok) {
    return <FormNotConfigured title={form.title} missing={limits.missing} />;
  }

  return (
    <FormPreview
      formId={formId}
      concertId={form.concertId}
      title={form.title}
      description={form.description}
      schema={schema}
      limits={limits.limits}
      copy={copy}
      status={form.status}
    />
  );
}
