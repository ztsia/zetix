import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { resolveFormCopy } from '@/lib/forms/resolve-copy';
import { resolveRepeaterLimits } from '@/lib/forms/limits';
import { parseFormSchema } from '@/lib/forms/schema';
import { blankFormSchema } from '@/lib/forms/templates';
import { FormBuilder } from '../builder/form-builder';
import { getForm, getFormCascade } from '../queries';
import { PARTY_CAP_KEY, vestigialCapWarning } from '../party-cap';

export const metadata: Metadata = { title: 'Questions' };

/**
 * `/admin/concerts/{id}/forms/{formId}` — the Questions tab: the builder
 * (spec/v2.md §8.2, spec/admin.md §14.1). The frame around it — title, status,
 * publish, the three tabs — is `layout.tsx`; Settings and Responses are their
 * own routes beside this one.
 *
 * A Server Component, because everything the builder needs to draw a faithful
 * preview is resolved here: the copy tokens and the repeater caps both come
 * through the cascade, and neither can be resolved in the browser
 * (spec/README.md §2.2).
 *
 * **A cap that resolves to nothing stops the preview rather than guessing.**
 * `resolveRepeaterLimits` refuses, and this page says which setting is missing
 * and where to enter it. Rendering "add up to 0 guests" because nobody has
 * configured the segment yet is the failure §2.1 exists to prevent.
 */

export default async function FormPage({
  params,
}: {
  params: Promise<{ concertId: string; formId: string }>;
}) {
  const { concertId: rawConcert, formId: rawForm } = await params;
  const concertId = Number(rawConcert);
  const formId = Number(rawForm);
  if (!Number.isInteger(concertId) || !Number.isInteger(formId)) notFound();

  const form = await getForm(concertId, formId);
  if (!form) notFound();

  /**
   * A form whose stored schema no longer parses still opens.
   *
   * The builder starts from the template for its kind and says so, rather than
   * refusing to render — an admin who cannot reach the screen cannot fix what
   * is on it. Nothing is written until they save.
   */
  const parsed = parseFormSchema(form.schema);
  const schema = parsed.ok ? parsed.schema : blankFormSchema(form.kind);

  const [cascade, copy, limits] = await Promise.all([
    getFormCascade(form),
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
      // A preview is a form nobody has filled in, so no base seats are held
      // yet. `M` passes the real figure for a returning player (§8.1.1).
      baseAlreadyClaimed: 0,
    }),
  ]);

  const capWarning = vestigialCapWarning(
    form.maxTicketsPerResponse,
    cascade[PARTY_CAP_KEY],
  );

  return (
    <>
      {!parsed.ok && (
        <Alert variant="destructive" className="mx-auto max-w-[770px]">
          <AlertTitle>This form&rsquo;s saved questions could not be read</AlertTitle>
          <AlertDescription className="whitespace-pre-wrap">
            {parsed.message}
            {'\n\n'}The builder below has started from a fresh {form.kind.toLowerCase()} form.
            Nothing is written until you save.
          </AlertDescription>
        </Alert>
      )}

      {capWarning && (
        <Alert variant="destructive" className="mx-auto max-w-[770px]">
          <AlertTitle>This form stores a party cap that nothing reads</AlertTitle>
          <AlertDescription>{capWarning}</AlertDescription>
        </Alert>
      )}

      {!limits.ok && (
        <Alert variant="destructive" className="mx-auto max-w-[770px]">
          <AlertTitle>This form cannot offer seats yet</AlertTitle>
          <AlertDescription>
            Nothing has set{' '}
            {limits.missing.map((key, index) => (
              <span key={key}>
                {index > 0 && ', '}
                <code>{key}</code>
              </span>
            ))}{' '}
            at any level, so the repeating sections have no row count and the form will not
            open. Enter it on the segment, on the{' '}
            <Link
              href={`/admin/concerts/${concertId}/shows`}
              className="underline underline-offset-4"
            >
              Shows
            </Link>{' '}
            screen.
          </AlertDescription>
        </Alert>
      )}

      <FormBuilder
        concertId={concertId}
        formId={formId}
        initialSchema={schema}
        initialTitle={form.title}
        initialDescription={form.descriptionMd ?? ''}
        copy={copy}
        readOnly={form.status === 'CLOSED'}
        // A key is frozen the moment a form can take an answer, because
        // answers are stored under it (spec/v2.md §8.2.3).
        canRekey={form.status === 'DRAFT'}
      />
    </>
  );
}
