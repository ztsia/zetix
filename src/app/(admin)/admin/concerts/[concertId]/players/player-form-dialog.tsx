'use client';

import { useId, type ReactNode } from 'react';
import { ActionDialog } from '../../action-dialog';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import type { FormState } from '../../form-state';
import { createPlayerAction, updatePlayerAction } from './actions';
import type { PlayerRow } from './players-table';

/**
 * Create or edit a player (spec/domain.md §5.1).
 *
 * Email is optional. A player without one still holds an invite token — the
 * token is the credential, not the address — and a section that rehearses
 * together often has one contact for several people.
 *
 * Active is on the form because it is the §7.4 lever: "reduce the quota, raise
 * capacity, or deactivate N players". Both directions can be refused by the
 * guard, and the refusal names the numbers.
 */
export function PlayerFormDialog({
  concertId,
  player,
  trigger,
}: {
  concertId: number;
  /** Absent when creating. */
  player?: PlayerRow;
  trigger: ReactNode;
}) {
  const id = useId();
  const editing = player !== undefined;

  const action = (formData: FormData): Promise<FormState> =>
    editing
      ? updatePlayerAction(concertId, player.id, { error: null }, formData)
      : createPlayerAction(concertId, { error: null }, formData);

  return (
    <ActionDialog
      trigger={trigger}
      title={editing ? `Edit ${player.fullName}` : 'New player'}
      description="Players perform; they hold no account and consume no seat of their own. What they hold is an entitlement to invite guests."
      submitLabel={editing ? 'Save player' : 'Add player'}
      pendingLabel="Saving…"
      action={action}
    >
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor={`${id}-name`}>Full name</FieldLabel>
          <Input
            id={`${id}-name`}
            name="fullName"
            required
            autoFocus
            defaultValue={player?.fullName ?? ''}
          />
        </Field>

        <Field>
          <FieldLabel htmlFor={`${id}-email`}>Email</FieldLabel>
          <Input
            id={`${id}-email`}
            name="email"
            type="email"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            defaultValue={player?.email ?? ''}
          />
          <FieldDescription>
            Optional, and matched without regard to case. Two players in one concert
            cannot share an address.
          </FieldDescription>
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor={`${id}-instrument`}>Instrument</FieldLabel>
            <Input
              id={`${id}-instrument`}
              name="instrument"
              defaultValue={player?.instrument ?? ''}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={`${id}-section`}>Section</FieldLabel>
            <Input
              id={`${id}-section`}
              name="section"
              defaultValue={player?.section ?? ''}
            />
          </Field>
        </div>

        <Field>
          <FieldLabel htmlFor={`${id}-active`}>Status</FieldLabel>
          <NativeSelect
            id={`${id}-active`}
            name="isActive"
            defaultValue={player === undefined || player.isActive ? 'true' : 'false'}
          >
            <option value="true">Active</option>
            <option value="false">Inactive</option>
          </NativeSelect>
          <FieldDescription>
            Only active players are entitled to base seats, so this changes what every
            player-invited segment in the concert has promised.
          </FieldDescription>
        </Field>
      </FieldGroup>
    </ActionDialog>
  );
}
