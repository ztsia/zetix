'use client';

import { useId, type ReactNode } from 'react';
import { ActionDialog } from '../../action-dialog';
import { CascadeHint } from '../../cascade-hint';
import { toLocalInput } from '../../local-time';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import type { FormState } from '../../form-state';
import type { ShowView } from './queries';
import { createShowAction, updateShowAction } from './actions';

/**
 * Create or edit a show — the hall and the door (spec/domain.md §5.1).
 *
 * One form for both, because they take exactly the same fields and a separate
 * create form is a second place for a field to be forgotten.
 *
 * **The show carries no audience mode.** That belongs to its segments, because
 * one hall on one night holds a public block and a player-invited block at the
 * same time (decision 5) — so there is deliberately no such control here.
 */
export function ShowFormDialog({
  concertId,
  show,
  timeZone,
  trigger,
}: {
  concertId: number;
  /** Absent when creating. */
  show?: ShowView;
  timeZone: string | null;
  trigger: ReactNode;
}) {
  const id = useId();
  const editing = show !== undefined;

  const action = (formData: FormData): Promise<FormState> =>
    editing
      ? updateShowAction(concertId, show.id, { error: null }, formData)
      : createShowAction(concertId, { error: null }, formData);

  return (
    <ActionDialog
      trigger={trigger}
      title={editing ? `Edit ${show.name}` : 'New show'}
      description={
        timeZone
          ? `Times are the clock at the venue — ${timeZone} — and are stored in UTC.`
          : 'This concert has no timezone yet, so times cannot be entered. Set one on the concert first.'
      }
      submitLabel={editing ? 'Save show' : 'Create show'}
      pendingLabel="Saving…"
      action={action}
    >
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor={`${id}-name`}>Name</FieldLabel>
          <Input
            id={`${id}-name`}
            name="name"
            required
            autoFocus
            defaultValue={show?.name ?? ''}
            placeholder="19 Sep"
          />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor={`${id}-starts`}>Starts</FieldLabel>
            <Input
              id={`${id}-starts`}
              name="startsAt"
              type="datetime-local"
              disabled={!timeZone}
              defaultValue={toLocalInput(show?.startsAt, timeZone)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={`${id}-doors`}>Doors open</FieldLabel>
            <Input
              id={`${id}-doors`}
              name="doorsOpenAt"
              type="datetime-local"
              disabled={!timeZone}
              defaultValue={toLocalInput(show?.doorsOpenAt, timeZone)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={`${id}-ends`}>Ends</FieldLabel>
            <Input
              id={`${id}-ends`}
              name="endsAt"
              type="datetime-local"
              disabled={!timeZone}
              defaultValue={toLocalInput(show?.endsAt, timeZone)}
            />
            {/*
              * The one field on this form that drives behaviour after the
              * night is over: the portal's post-show phase and auto-completion
              * both measure from it (spec/v2.md §13.2.1). Left blank, neither
              * happens and the show is completed by hand — which is a real
              * configuration, not an oversight, so this does not nag.
              */}
            <FieldDescription>
              Optional. The portal shows its post-show page, and the show
              auto-completes, once this has passed by
              {' '}
              <code>show.auto_complete_after_hours</code>. Leave it blank to do
              both by hand.
            </FieldDescription>
          </Field>
        </div>

        <Field>
          <FieldLabel htmlFor={`${id}-venue`}>Venue</FieldLabel>
          <Input
            id={`${id}-venue`}
            name="venueName"
            defaultValue={show?.venueName ?? ''}
            placeholder="Concert hall"
          />
        </Field>

        <Field>
          <FieldLabel htmlFor={`${id}-address`}>Address</FieldLabel>
          <Input
            id={`${id}-address`}
            name="venueAddress"
            defaultValue={show?.venueAddress ?? ''}
          />
        </Field>

        <Field>
          <FieldLabel htmlFor={`${id}-capacity`}>Capacity</FieldLabel>
          <Input
            id={`${id}-capacity`}
            name="capacity"
            type="number"
            min={0}
            inputMode="numeric"
            defaultValue={show?.raw.capacity ?? ''}
          />
          {/* One number, not three. Seats you want to withhold are seats you
              give to no segment — there is no held-seats field (decision 21). */}
          <CascadeHint resolved={show?.resolved['capacity']} level="show" />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor={`${id}-status`}>Status</FieldLabel>
            <NativeSelect
              id={`${id}-status`}
              name="status"
              defaultValue={show?.status ?? 'DRAFT'}
            >
              <option value="DRAFT">Draft</option>
              <option value="OPEN">Open</option>
              <option value="CLOSED">Closed</option>
              <option value="COMPLETED">Completed</option>
            </NativeSelect>
          </Field>

          <Field>
            <FieldLabel htmlFor={`${id}-portal`}>Portal unlock</FieldLabel>
            <NativeSelect
              id={`${id}-portal`}
              name="portalUnlockMode"
              defaultValue={show?.raw.portalUnlockMode ?? ''}
            >
              <option value="">Inherit</option>
              <option value="ON_ADMISSION">On admission</option>
              <option value="OPEN_TO_ALL">Open to all</option>
              <option value="CLOSED">Closed</option>
            </NativeSelect>
            <CascadeHint resolved={show?.resolved['portal.unlock_mode']} level="show" />
          </Field>
        </div>
      </FieldGroup>
    </ActionDialog>
  );
}
