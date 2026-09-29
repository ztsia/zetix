'use client';

import { useId, useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { CalendarPlus, Plus } from 'lucide-react';
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { createConcertAction } from './actions';
import { NO_FORM_STATE, slugify } from './form-state';


/**
 * The timezone list, from the runtime's own tz database.
 *
 * Not a constant in this file: a hardcoded list goes stale when a zone is
 * renamed, and writing this concert's zone here would put a `context.md` value
 * into code (CLAUDE.md). `supportedValuesOf` is Node 18+ and every browser this
 * console supports; the fallback keeps the field usable rather than empty if it
 * is ever missing, since the action validates the value anyway.
 */
export function timezoneOptions(): string[] {
  const supported = Intl as typeof Intl & {
    supportedValuesOf?: (key: string) => string[];
  };
  try {
    return supported.supportedValuesOf?.('timeZone') ?? [];
  } catch {
    return [];
  }
}

function SubmitButton({ pending }: { pending: boolean }) {
  return (
    <Button type="submit" disabled={pending}>
      {pending ? <Spinner /> : <CalendarPlus />}
      {pending ? 'Creating…' : 'Create concert'}
    </Button>
  );
}

/**
 * Create a concert (spec/admin.md §14.1).
 *
 * A `Dialog` rather than a page: creating a concert is six fields and the admin
 * is choosing one from the list behind it, so a full navigation loses their
 * place for no gain. It is a form, not a destructive confirmation, which is what
 * separates `Dialog` from `AlertDialog` here.
 *
 * **No number on this form is an operational value.** A concert is a name, a
 * zone and some dates; capacities, quotas and deadlines arrive on the shows
 * screen and resolve through the cascade (CLAUDE.md, spec/README.md §2.2).
 */
export function ConcertCreateDialog() {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [timezone, setTimezone] = useState('');
  const [isPending, startTransition] = useTransition();
  const router = useRouter();
  const fieldId = useId();
  const zones = useMemo(() => timezoneOptions(), []);

  // The derived slug is a *preview* of what the action will compute from the
  // name when the field is left blank; the action re-derives it rather than
  // trusting this, so the two cannot disagree.
  const derived = slugify(name);

  /**
   * The result decides whether the dialog closes, so the action is awaited here
   * rather than driven through `useActionState`.
   *
   * Closing on submit and reporting the error afterwards would throw away a form
   * the admin has just filled in — and several of these errors are worth
   * correcting in place rather than retyping six fields.
   */
  function submit(formData: FormData) {
    setError(null);
    startTransition(async () => {
      const result = await createConcertAction(NO_FORM_STATE, formData);
      if (result.error) {
        setError(result.error);
        return;
      }
      setOpen(false);
      setName('');
      setSlug('');
      setTimezone('');
      // The list is a Server Component reading the row this just inserted.
      // `revalidatePath` in the action invalidates it; this makes the open page
      // actually re-fetch rather than waiting for the next navigation.
      router.refresh();
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button />}>
        <Plus />
        New concert
      </DialogTrigger>

      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New concert</DialogTitle>
          <DialogDescription>
            Shows, segments and capacities are added afterwards, on the concert&rsquo;s own
            screens.
          </DialogDescription>
        </DialogHeader>

        <form action={submit} className="flex flex-col gap-6">
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor={`${fieldId}-name`}>Name</FieldLabel>
              <Input
                id={`${fieldId}-name`}
                name="name"
                required
                autoFocus
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="September concert"
              />
            </Field>

            <Field>
              <FieldLabel htmlFor={`${fieldId}-slug`}>Slug</FieldLabel>
              <Input
                id={`${fieldId}-slug`}
                name="slug"
                value={slug}
                onChange={(event) => setSlug(event.target.value)}
                placeholder={derived || 'september-concert'}
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
              />
              <FieldDescription>
                {slug
                  ? 'Appears in links, so it has to be unique.'
                  : derived
                    ? `Leave blank to use “${derived}”.`
                    : 'Derived from the name if you leave it blank.'}
              </FieldDescription>
            </Field>

            <Field>
              <FieldLabel htmlFor={`${fieldId}-timezone`}>Timezone</FieldLabel>
              {/* The value the action reads. The combobox is a picker over it,
                  so the field posts correctly whether it was typed or clicked. */}
              <input type="hidden" name="timezone" value={timezone} />
              <Combobox
                items={zones}
                value={timezone}
                onValueChange={(next: string | null) => setTimezone(next ?? '')}
              >
                <ComboboxInput
                  id={`${fieldId}-timezone`}
                  placeholder="Search zones, e.g. Asia/Kuala_Lumpur"
                  aria-required
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
                Every show time is stored in UTC and shown in this zone — never the
                viewer&rsquo;s.
              </FieldDescription>
            </Field>

            <Field>
              <FieldLabel htmlFor={`${fieldId}-season`}>Season</FieldLabel>
              <Input id={`${fieldId}-season`} name="season" placeholder="2026" />
            </Field>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor={`${fieldId}-starts`}>Starts on</FieldLabel>
                <Input id={`${fieldId}-starts`} name="startsOn" type="date" />
              </Field>
              <Field>
                <FieldLabel htmlFor={`${fieldId}-ends`}>Ends on</FieldLabel>
                <Input id={`${fieldId}-ends`} name="endsOn" type="date" />
              </Field>
            </div>
          </FieldGroup>

          {error && (
            <Alert variant="destructive" role="alert">
              {/* Shown whole. Several of these come from the database and name
                  the numbers and the ways out; truncating one removes the part
                  that tells the admin what to do (spec/allocation.md §7.4). */}
              <AlertTitle className="whitespace-pre-wrap">{error}</AlertTitle>
            </Alert>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" disabled={isPending} onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <SubmitButton pending={isPending} />
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
