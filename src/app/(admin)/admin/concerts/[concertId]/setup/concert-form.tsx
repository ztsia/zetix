'use client';

import { useId, useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Check } from 'lucide-react';
import { Alert, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from '@/components/ui/combobox';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { Spinner } from '@/components/ui/spinner';
import { AdminOnly, useCanEdit } from '@/components/auth/role';
import { timezoneOptions } from '../../concert-create-dialog';
import { NO_FORM_STATE } from '../../form-state';
import { updateConcertAction } from './actions';

export type ConcertFields = {
  id: number;
  name: string;
  slug: string;
  season: string | null;
  timezone: string | null;
  startsOn: string | null;
  endsOn: string | null;
  status: 'DRAFT' | 'ACTIVE' | 'ARCHIVED';
};

/**
 * The concert itself: name, slug, season, zone, dates and whether it is live
 * (spec/v3.md §29.1 — "Concert (editable)"). Creating a concert is still the
 * list's dialog; this is the same fields, after the fact.
 *
 * A viewer sees the same form with every field disabled and no Save.
 */
export function ConcertForm({ concert }: { concert: ConcertFields }) {
  const canEdit = useCanEdit();
  const archived = concert.status === 'ARCHIVED';
  const disabled = !canEdit || archived;
  const [timezone, setTimezone] = useState(concert.timezone ?? '');
  const [result, setResult] = useState<{ error: string | null; message?: string | null } | null>(null);
  const [isPending, startTransition] = useTransition();
  const router = useRouter();
  const id = useId();
  const zones = useMemo(() => timezoneOptions(), []);

  function submit(formData: FormData) {
    setResult(null);
    startTransition(async () => {
      const state = await updateConcertAction(NO_FORM_STATE, formData);
      setResult(state);
      if (!state.error) router.refresh();
    });
  }

  return (
    <form action={submit} className="flex flex-col gap-4">
      <input type="hidden" name="concertId" value={concert.id} />
      <FieldGroup className="grid gap-4 md:grid-cols-2">
        <Field>
          <FieldLabel htmlFor={`${id}-name`}>Name</FieldLabel>
          <Input id={`${id}-name`} name="name" defaultValue={concert.name} required disabled={disabled} />
        </Field>
        <Field>
          <FieldLabel htmlFor={`${id}-season`}>Season</FieldLabel>
          <Input id={`${id}-season`} name="season" defaultValue={concert.season ?? ''} disabled={disabled} />
        </Field>
        <Field>
          <FieldLabel htmlFor={`${id}-slug`}>Slug</FieldLabel>
          <Input id={`${id}-slug`} name="slug" defaultValue={concert.slug} required disabled={disabled} />
          <FieldDescription>Unique across concerts. No public link carries it.</FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor={`${id}-status`}>Status</FieldLabel>
          {archived ? (
            <Input id={`${id}-status`} value="Archived" disabled readOnly />
          ) : (
            <NativeSelect id={`${id}-status`} name="status" defaultValue={concert.status} disabled={disabled}>
              <option value="DRAFT">Draft</option>
              <option value="ACTIVE">Active</option>
            </NativeSelect>
          )}
          <FieldDescription>Archive or restore it from the concert list.</FieldDescription>
        </Field>
        <Field className="md:col-span-2">
          <FieldLabel htmlFor={`${id}-timezone`}>Timezone</FieldLabel>
          <input type="hidden" name="timezone" value={timezone} />
          <Combobox
            items={zones}
            value={timezone}
            onValueChange={(next: string | null) => setTimezone(next ?? '')}
          >
            <ComboboxInput
              id={`${id}-timezone`}
              placeholder="Search zones, e.g. Asia/Kuala_Lumpur"
              aria-required
              disabled={disabled}
            />
            <ComboboxContent>
              <ComboboxEmpty>No zone matches that.</ComboboxEmpty>
              <ComboboxList>
                {(zone: string) => (
                  <ComboboxItem key={zone} value={zone}>
                    {zone}
                  </ComboboxItem>
                )}
              </ComboboxList>
            </ComboboxContent>
          </Combobox>
          <FieldDescription>
            Every time is stored as an instant and shown in this zone. Changing it keeps each show at
            the same instant, so its wall-clock time at the venue changes.
          </FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor={`${id}-starts`}>Starts on</FieldLabel>
          <Input id={`${id}-starts`} name="startsOn" type="date" defaultValue={concert.startsOn ?? ''} disabled={disabled} />
        </Field>
        <Field>
          <FieldLabel htmlFor={`${id}-ends`}>Ends on</FieldLabel>
          <Input id={`${id}-ends`} name="endsOn" type="date" defaultValue={concert.endsOn ?? ''} disabled={disabled} />
        </Field>
      </FieldGroup>

      {result?.error ? (
        <Alert variant="destructive" role="alert">
          <AlertTitle className="whitespace-pre-wrap">{result.error}</AlertTitle>
        </Alert>
      ) : null}

      {archived ? null : (
        <AdminOnly>
          <div className="flex items-center gap-3">
            <Button type="submit" disabled={isPending}>
              {isPending ? <Spinner data-icon="inline-start" /> : null}
              Save concert
            </Button>
            {result && !result.error && result.message ? (
              <span className="text-muted-foreground flex items-center gap-1.5 text-sm" role="status">
                <Check className="size-4" />
                {result.message}
              </span>
            ) : null}
          </div>
        </AdminOnly>
      )}
    </form>
  );
}
