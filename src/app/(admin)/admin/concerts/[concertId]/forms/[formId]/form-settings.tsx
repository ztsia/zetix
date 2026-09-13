'use client';

import { useId, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Save } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { saveFormSettingsAction } from '../actions';

/**
 * The form's own settings — its window, its limits and its copy (spec/v2.md §8.3).
 *
 * **What is not on this screen is the point of it.** Party size, base quota,
 * extra rows and the claim deadline are *segment* values (`domain.md` §6) and
 * they resolve through the cascade, so they appear here as read-only facts with
 * a link to where they are set. Offering them as inputs would write a fifth
 * cascade level that `resolve_setting()` does not have — and the admin would
 * have configured something that nothing reads (`party-cap.ts`, decision 43).
 *
 * Everything that *is* here is a property of this form rather than of the
 * audience it serves: when it opens, how many responses it takes, whether one
 * person may answer twice, and how long they may go back and correct it.
 */

export function FormSettings({
  concertId,
  formId,
  defaults,
  timeZone,
}: {
  concertId: number;
  formId: number;
  defaults: {
    title: string;
    roundLabel: string | null;
    slug: string;
    descriptionMd: string | null;
    confirmationMessageMd: string | null;
    opensAt: string;
    closesAt: string;
    allowEditUntil: string;
    maxResponses: number | null;
    oneResponsePerIdentity: boolean;
    autoCloseOnCapacity: boolean;
  };
  timeZone: string | null;
}) {
  const id = useId();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function submit(formData: FormData) {
    setError(null);
    setMessage(null);
    startTransition(async () => {
      const result = await saveFormSettingsAction(concertId, formId, { error: null }, formData);
      if (result.error) {
        setError(result.error);
        return;
      }
      setMessage(result.message ?? 'Saved.');
      router.refresh();
    });
  }

  return (
    <form action={submit} className="flex max-w-2xl flex-col gap-6">
      {!timeZone && (
        <Alert variant="destructive">
          <AlertTitle>This concert has no timezone</AlertTitle>
          <AlertDescription>
            A form window is read against the venue&rsquo;s clock, so it cannot be stored
            until the concert has a zone. Set one on the concert first.
          </AlertDescription>
        </Alert>
      )}

      <FieldSet>
        <FieldLegend>Identity</FieldLegend>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor={`${id}-title`}>Title</FieldLabel>
            <Input id={`${id}-title`} name="title" required defaultValue={defaults.title} />
          </Field>

          <Field>
            <FieldLabel htmlFor={`${id}-round`}>Round</FieldLabel>
            <Input
              id={`${id}-round`}
              name="roundLabel"
              defaultValue={defaults.roundLabel ?? ''}
              placeholder="Round 1"
            />
            <FieldDescription>
              How two rounds on the same segment are told apart.
            </FieldDescription>
          </Field>

          <Field>
            <FieldLabel htmlFor={`${id}-slug`}>Link</FieldLabel>
            <Input id={`${id}-slug`} name="slug" required defaultValue={defaults.slug} />
            <FieldDescription>
              <code className="text-xs">/f/{defaults.slug}</code> — unique across every
              concert. Changing it breaks any link already shared.
            </FieldDescription>
          </Field>

          <Field>
            <FieldLabel htmlFor={`${id}-description`}>Introduction</FieldLabel>
            <Textarea
              id={`${id}-description`}
              name="descriptionMd"
              rows={3}
              defaultValue={defaults.descriptionMd ?? ''}
            />
            <FieldDescription>Shown above the first question.</FieldDescription>
          </Field>

          <Field>
            <FieldLabel htmlFor={`${id}-confirmation`}>Confirmation message</FieldLabel>
            <Textarea
              id={`${id}-confirmation`}
              name="confirmationMessageMd"
              rows={3}
              defaultValue={defaults.confirmationMessageMd ?? ''}
            />
            <FieldDescription>
              Shown after a successful submission, above the seats granted.
            </FieldDescription>
          </Field>
        </FieldGroup>
      </FieldSet>

      <FieldSet>
        <FieldLegend>Window</FieldLegend>
        <FieldDescription>
          {timeZone
            ? `Times are the venue's clock (${timeZone}), never the reader's.`
            : 'Set a concert timezone before entering times.'}
        </FieldDescription>
        <FieldGroup>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor={`${id}-opens`}>Opens</FieldLabel>
              <Input
                id={`${id}-opens`}
                name="opensAt"
                type="datetime-local"
                defaultValue={defaults.opensAt}
                disabled={!timeZone}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={`${id}-closes`}>Closes</FieldLabel>
              <Input
                id={`${id}-closes`}
                name="closesAt"
                type="datetime-local"
                defaultValue={defaults.closesAt}
                disabled={!timeZone}
              />
            </Field>
          </div>

          <Field>
            <FieldLabel htmlFor={`${id}-edit-until`}>Editable until</FieldLabel>
            <Input
              id={`${id}-edit-until`}
              name="allowEditUntil"
              type="datetime-local"
              defaultValue={defaults.allowEditUntil}
              disabled={!timeZone}
            />
            <FieldDescription>
              How long a registrant may go back and correct their answers. An edit may
              correct or reduce, never add seats.
            </FieldDescription>
          </Field>
        </FieldGroup>
      </FieldSet>

      <FieldSet>
        <FieldLegend>Limits</FieldLegend>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor={`${id}-max`}>Maximum responses</FieldLabel>
            <Input
              id={`${id}-max`}
              name="maxResponses"
              type="number"
              min={1}
              inputMode="numeric"
              defaultValue={defaults.maxResponses ?? ''}
            />
            <FieldDescription>
              Blank for no limit. This caps <em>responses</em>, not seats — capacity is
              the segment&rsquo;s, and the allocation engine is what enforces it.
            </FieldDescription>
          </Field>

          <Field orientation="horizontal">
            <Switch
              id={`${id}-identity`}
              name="oneResponsePerIdentity"
              defaultChecked={defaults.oneResponsePerIdentity}
            />
            <FieldLabel htmlFor={`${id}-identity`}>One response per person</FieldLabel>
          </Field>
          <FieldDescription>
            Keyed on the player token, or the email address. A returning visitor loads
            their existing response to edit rather than starting a second one.
          </FieldDescription>

          <Field orientation="horizontal">
            <Switch
              id={`${id}-auto-close`}
              name="autoCloseOnCapacity"
              defaultChecked={defaults.autoCloseOnCapacity}
            />
            <FieldLabel htmlFor={`${id}-auto-close`}>Close when the segment is full</FieldLabel>
          </Field>
        </FieldGroup>
      </FieldSet>

      {error && (
        <Alert variant="destructive" role="alert">
          <AlertTitle className="text-sm leading-relaxed font-normal whitespace-pre-wrap">
            {error}
          </AlertTitle>
        </Alert>
      )}

      {message && (
        <Alert>
          <AlertTitle className="text-sm font-normal">{message}</AlertTitle>
        </Alert>
      )}

      <div>
        <Button type="submit" disabled={isPending}>
          {isPending ? <Spinner /> : <Save />}
          {isPending ? 'Saving…' : 'Save settings'}
        </Button>
      </div>
    </form>
  );
}
