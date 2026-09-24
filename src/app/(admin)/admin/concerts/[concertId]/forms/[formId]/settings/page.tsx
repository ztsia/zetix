import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getForm, getFormCascade } from '../../queries';
import { FormSettings } from '../form-settings';
import { ResolvedFacts } from '../resolved-facts';

export const metadata: Metadata = { title: 'Settings' };

/**
 * `/admin/concerts/{id}/forms/{formId}/settings` — the Settings tab.
 *
 * Two cards, as Google Forms stacks them: what this form decides (its window,
 * its limits, its copy), then what it inherits from its segment and cannot
 * change here (spec/v2.md §8.3, decision 43).
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

export default async function FormSettingsPage({
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

  const cascade = await getFormCascade(form);

  return (
    <div className="mx-auto flex w-full max-w-[770px] flex-col gap-3">
      <FormSettings
        concertId={concertId}
        formId={formId}
        timeZone={form.timeZone}
        defaults={{
          roundLabel: form.roundLabel,
          slug: form.slug,
          confirmationMessageMd: form.confirmationMessageMd,
          opensAt: toLocalInput(form.opensAt, form.timeZone),
          closesAt: toLocalInput(form.closesAt, form.timeZone),
          allowEditUntil: toLocalInput(form.allowEditUntil, form.timeZone),
          maxResponses: form.maxResponses,
          oneResponsePerIdentity: form.oneResponsePerIdentity ?? false,
          autoCloseOnCapacity: form.autoCloseOnCapacity ?? false,
        }}
      />

      <ResolvedFacts
        concertId={concertId}
        segmentId={form.segmentId}
        cascade={cascade}
        timeZone={form.timeZone}
      />
    </div>
  );
}
