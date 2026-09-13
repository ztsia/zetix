'use client';

import { useId, useMemo, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { ActionDialog } from '../../action-dialog';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import type { FormKind } from '@/lib/forms/schema';
import type { FormState } from '../../form-state';
import { createFormAction } from './actions';

/**
 * A new form: pick the kind, then where it belongs (spec/v2.md §8.1, §13.5).
 *
 * **The kind chooses the parent list, not the other way round.** `PLAYER` and
 * `PUBLIC` offer segments whose `audience_mode` matches — a player form on a
 * public segment has no players to entitle — and `FEEDBACK` offers shows,
 * because it hangs off the show and creates no seats at all. Filtering here is
 * a courtesy; `createFormAction` refuses the mismatch again, because a dropdown
 * is not a constraint.
 *
 * There is no question anywhere on this dialog about which field means the
 * email. The blocks come from the kind (decision 35).
 */

type Parent = {
  id: number;
  name: string;
  segments: { id: number; name: string; audienceMode: 'PLAYER_INVITED' | 'PUBLIC' }[];
};

const KIND_HELP: Record<FormKind, string> = {
  PLAYER: 'Players claim their base seats and may request extras. Belongs to a player-invited segment.',
  PUBLIC: 'Anyone registers a party. The registrant is seat #1. Belongs to a public segment.',
  FEEDBACK: 'Asked after the concert, from the ticket link. Belongs to a show and creates no seats.',
};

export function FormCreateDialog({
  concertId,
  parents,
  trigger,
}: {
  concertId: number;
  parents: Parent[];
  trigger: ReactNode;
}) {
  const id = useId();
  const router = useRouter();
  const [kind, setKind] = useState<FormKind>('PUBLIC');

  /** What this kind may attach to, flattened to one list of options. */
  const options = useMemo(() => {
    if (kind === 'FEEDBACK') {
      return parents.map((show) => ({ value: show.id, label: show.name }));
    }
    const wanted = kind === 'PLAYER' ? 'PLAYER_INVITED' : 'PUBLIC';
    return parents.flatMap((show) =>
      show.segments
        .filter((segment) => segment.audienceMode === wanted)
        .map((segment) => ({ value: segment.id, label: `${show.name} — ${segment.name}` })),
    );
  }, [kind, parents]);

  const action = (formData: FormData): Promise<FormState> =>
    createFormAction(concertId, { error: null }, formData);

  return (
    <ActionDialog
      trigger={trigger}
      title="New form"
      description="Its questions come from the kind you choose. You can edit their wording, not what they collect."
      submitLabel="Create form"
      pendingLabel="Creating…"
      action={action}
      onSuccess={(result) => {
        // The action returns the new id, so the admin lands in the builder
        // rather than on a list they have to find it in.
        if (result.message) router.push(`/admin/concerts/${concertId}/forms/${result.message}`);
      }}
    >
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor={`${id}-kind`}>Kind</FieldLabel>
          <NativeSelect
            id={`${id}-kind`}
            name="kind"
            value={kind}
            onChange={(event) => setKind(event.target.value as FormKind)}
          >
            <option value="PUBLIC">Public registration</option>
            <option value="PLAYER">Player registration</option>
            <option value="FEEDBACK">Post-show feedback</option>
          </NativeSelect>
          <FieldDescription>{KIND_HELP[kind]}</FieldDescription>
        </Field>

        <Field>
          <FieldLabel htmlFor={`${id}-parent`}>
            {kind === 'FEEDBACK' ? 'Show' : 'Segment'}
          </FieldLabel>
          <NativeSelect id={`${id}-parent`} name="parentId" required disabled={options.length === 0}>
            {options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </NativeSelect>
          {options.length === 0 && (
            <FieldDescription>
              {kind === 'FEEDBACK'
                ? 'This concert has no shows yet.'
                : `No ${kind === 'PLAYER' ? 'player-invited' : 'public'} segment exists yet. Add one on the Shows screen first — the segment owns the capacity and the caps this form will offer.`}
            </FieldDescription>
          )}
        </Field>

        <Field>
          <FieldLabel htmlFor={`${id}-title`}>Title</FieldLabel>
          <Input
            id={`${id}-title`}
            name="title"
            required
            autoFocus
            placeholder={kind === 'FEEDBACK' ? 'How was your evening?' : 'Register for the concert'}
          />
        </Field>

        <Field>
          <FieldLabel htmlFor={`${id}-round`}>Round</FieldLabel>
          <Input id={`${id}-round`} name="roundLabel" placeholder="Round 1" />
          <FieldDescription>
            Optional, and how two rounds on one segment are told apart. A second round is
            always a new form, never an edit of the first.
          </FieldDescription>
        </Field>

        <Field>
          <FieldLabel htmlFor={`${id}-slug`}>Link</FieldLabel>
          <Input id={`${id}-slug`} name="slug" placeholder="Taken from the title" />
          <FieldDescription>
            The form lives at <code className="text-xs">/f/&lt;link&gt;</code>. It must be
            unique across every concert.
          </FieldDescription>
        </Field>
      </FieldGroup>
    </ActionDialog>
  );
}
