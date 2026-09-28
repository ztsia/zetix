'use client';

import * as React from 'react';
import { Mail } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Switch } from '@/components/ui/switch';
import { CommandDialog } from '../commands/command-dialog';

export type InviteFormOption = { id: number; label: string; open: boolean };

/**
 * *Invite players* (spec/v3.md §25.2): each active player emailed their own
 * prefilled link to one player form. Optional — the form's public link and its
 * picker already work — and run as a command, so the preview lists who will
 * be emailed and who is skipped before anything is queued.
 */
export function InvitePlayersButton({
  concertId,
  forms,
  playerIds,
  trigger,
}: {
  concertId: number;
  forms: InviteFormOption[];
  /** One player from their row; every active player when omitted. */
  playerIds?: number[];
  trigger?: React.ReactElement;
}) {
  const first = forms.find((form) => form.open) ?? forms[0];
  if (!first) return null;
  return (
    <CommandDialog
      concertId={concertId}
      command="intake.invite_players"
      selection={playerIds ? { ids: playerIds } : { filter: { active: true }, excludedIds: [] }}
      params={{ formId: first.id, again: false }}
      trigger={
        trigger ?? (
          <Button variant="outline">
            <Mail />
            Invite players…
          </Button>
        )
      }
      renderOptions={(raw, set) => <InviteOptions forms={forms} params={raw as Params} set={set} />}
    />
  );
}

type Params = { formId: number; again: boolean };

function InviteOptions({
  forms,
  params,
  set,
}: {
  forms: InviteFormOption[];
  params: Params;
  set: (next: unknown) => void;
}) {
  const formId = React.useId();
  const againId = React.useId();
  return (
    <>
      <Field>
        <FieldLabel htmlFor={formId}>Form</FieldLabel>
        <NativeSelect
          id={formId}
          className="w-full"
          value={String(params.formId)}
          onChange={(event) => set({ ...params, formId: Number(event.target.value) })}
        >
          {forms.map((form) => (
            <NativeSelectOption key={form.id} value={form.id}>
              {form.label}
              {form.open ? '' : ' (not open)'}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <FieldDescription>Each player gets this form’s link with their name already chosen.</FieldDescription>
      </Field>
      <Field orientation="horizontal">
        <Switch
          id={againId}
          checked={params.again}
          onCheckedChange={(checked: boolean) => set({ ...params, again: checked })}
        />
        <div className="flex flex-col gap-0.5">
          <FieldLabel htmlFor={againId}>Send again to players already invited</FieldLabel>
          <FieldDescription>Off: a player who already has this link is skipped.</FieldDescription>
        </div>
      </Field>
    </>
  );
}
