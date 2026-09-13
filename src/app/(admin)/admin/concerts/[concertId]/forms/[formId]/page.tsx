import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, Inbox } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { resolveFormCopy } from '@/lib/forms/resolve-copy';
import { resolveRepeaterLimits } from '@/lib/forms/limits';
import { parseFormSchema } from '@/lib/forms/schema';
import { blankFormSchema } from '@/lib/forms/templates';
import { FormBuilder } from '../builder/form-builder';
import { getForm, getFormCascade } from '../queries';
import { PARTY_CAP_KEY, vestigialCapWarning } from '../party-cap';
import { FormSettings } from './form-settings';
import { ResolvedFacts } from './resolved-facts';
import { StatusControls } from './status-controls';

export const metadata: Metadata = { title: 'Form' };

/**
 * `/admin/concerts/{id}/forms/{formId}` — the builder, the settings and the
 * facts this form inherits (spec/v2.md §8.2, spec/admin.md §14.1).
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

/** `datetime-local` wants `YYYY-MM-DDTHH:mm` in the venue's zone, not an ISO instant. */
function toLocalInput(value: Date | null, timeZone: string | null): string {
  if (!value || !timeZone) return '';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(value);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  const hour = get('hour') === '24' ? '00' : get('hour');
  return `${get('year')}-${get('month')}-${get('day')}T${hour}:${get('minute')}`;
}

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
    <div className="flex flex-col gap-4">
      <div>
        <Button
          variant="ghost"
          size="sm"
          className="-ml-2"
          render={<Link href={`/admin/concerts/${concertId}/forms`} />}
        >
          <ArrowLeft />
          All forms
        </Button>
      </div>

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="flex flex-wrap items-center gap-2 text-xl font-semibold">
            {form.title}
            {form.roundLabel && <Badge variant="outline">{form.roundLabel}</Badge>}
            <Badge variant={form.status === 'OPEN' ? 'default' : 'secondary'}>
              {form.status.toLowerCase()}
            </Badge>
          </h1>
          <p className="text-muted-foreground text-sm">
            {form.showName}
            {form.segmentName ? ` · ${form.segmentName}` : ''} · /f/{form.slug} · schema v
            {form.schemaVersion}
          </p>
        </div>

        <div className="flex flex-col items-end gap-2">
          <Button
            variant="outline"
            size="sm"
            render={<Link href={`/admin/concerts/${concertId}/forms/${formId}/responses`} />}
          >
            <Inbox />
            {form.responses === 1 ? '1 response' : `${form.responses} responses`}
          </Button>
          <StatusControls
            concertId={concertId}
            formId={formId}
            status={form.status}
            responses={form.responses}
            title={form.title}
          />
        </div>
      </div>

      {!parsed.ok && (
        <Alert variant="destructive">
          <AlertTitle>This form&rsquo;s saved questions could not be read</AlertTitle>
          <AlertDescription className="whitespace-pre-wrap">
            {parsed.message}
            {'\n\n'}The builder below has started from a fresh {form.kind.toLowerCase()} form.
            Nothing is written until you save.
          </AlertDescription>
        </Alert>
      )}

      {capWarning && (
        <Alert variant="destructive">
          <AlertTitle>This form stores a party cap that nothing reads</AlertTitle>
          <AlertDescription>{capWarning}</AlertDescription>
        </Alert>
      )}

      {!limits.ok && (
        <Alert variant="destructive">
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

      <Tabs defaultValue="questions">
        <TabsList>
          <TabsTrigger value="questions">Questions</TabsTrigger>
          <TabsTrigger value="settings">Settings</TabsTrigger>
          <TabsTrigger value="inherited">Inherited</TabsTrigger>
        </TabsList>

        <TabsContent value="questions" className="pt-4">
          <FormBuilder
            concertId={concertId}
            formId={formId}
            initialSchema={schema}
            limits={limits.ok ? limits.limits : {}}
            copy={copy}
            readOnly={form.status === 'CLOSED'}
          />
        </TabsContent>

        <TabsContent value="settings" className="pt-4">
          <FormSettings
            concertId={concertId}
            formId={formId}
            timeZone={form.timeZone}
            defaults={{
              title: form.title,
              roundLabel: form.roundLabel,
              slug: form.slug,
              descriptionMd: form.descriptionMd,
              confirmationMessageMd: form.confirmationMessageMd,
              opensAt: toLocalInput(form.opensAt, form.timeZone),
              closesAt: toLocalInput(form.closesAt, form.timeZone),
              allowEditUntil: toLocalInput(form.allowEditUntil, form.timeZone),
              maxResponses: form.maxResponses,
              oneResponsePerIdentity: form.oneResponsePerIdentity ?? false,
              autoCloseOnCapacity: form.autoCloseOnCapacity ?? false,
            }}
          />
        </TabsContent>

        <TabsContent value="inherited" className="pt-4">
          <ResolvedFacts
            concertId={concertId}
            segmentId={form.segmentId}
            cascade={cascade}
            timeZone={form.timeZone}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
