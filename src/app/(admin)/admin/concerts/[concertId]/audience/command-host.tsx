'use client';

import * as React from 'react';
import type { LucideIcon } from 'lucide-react';
import {
  ArchiveRestore,
  ArrowRightLeft,
  BadgeCheck,
  BellRing,
  CircleCheck,
  CircleX,
  ClipboardCheck,
  DoorOpen,
  Eraser,
  Gift,
  ListOrdered,
  MailCheck,
  MailQuestion,
  PencilLine,
  RefreshCw,
  ShieldAlert,
  Ticket,
  Trash2,
  Undo2,
  UserCheck,
  Hourglass,
  Tags,
  Send,
  Repeat,
  HandHelping,
  MailX,
  RotateCw,
  Ban,
} from 'lucide-react';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Switch } from '@/components/ui/switch';
import type { Selection } from '@/lib/commands/selection';
import type { AudienceFilter } from '@/lib/audience/filter';
import { CommandDialog } from '../commands/command-dialog';
import { SendWizard } from './send/send-wizard';

/**
 * The Audience workspace's commands, as the screens offer them
 * (spec/v3.md §23.2), and the one host that runs them.
 *
 * **One dialog per page, outside every row.** A command chosen from a menu has
 * no button of its own, and a per-seat menu sits in a row that the command may
 * remove — a dialog mounted there would vanish with its report. So menus ask
 * the host to open a command, and the host keeps the dialog mounted until it
 * closes.
 */

export type Grain = 'parties' | 'seats';

type OptionsKind = 'override' | 'segment' | 'status' | 'edit-field' | 'include-flagged';

export type CommandEntry = {
  command: string;
  label: string;
  icon: LucideIcon;
  /** `messages` entries act on outbox rows: the record's Conversation and the Messages view. */
  grain: Grain | 'messages';
  group: 'Review' | 'Allocation' | 'Verification' | 'Address' | 'Tickets' | 'Delivery' | 'Messages' | 'Door' | 'Records';
  options?: OptionsKind;
  /** Opens the send wizard (spec/v3.md §24.1) rather than the plain command dialog. */
  wizard?: boolean;
  params?: unknown;
  destructive?: boolean;
};

/**
 * Every command the Audience workspace offers, grouped as §23.2 groups them.
 * Delivery is the send wizard's (module `T`; Messages act on messages, in the
 * Messages view), and Merge parties and Not a duplicate are duplicate
 * review's (module `V`).
 */
export const COMMAND_ENTRIES: CommandEntry[] = [
  { command: 'audience.approve', label: 'Approve', icon: BadgeCheck, grain: 'parties', group: 'Review', options: 'include-flagged', params: { includeFlagged: false } },
  { command: 'audience.grant_extras', label: 'Grant extras', icon: Gift, grain: 'parties', group: 'Review', options: 'override', params: { override: false } },
  { command: 'audience.decline_extras', label: 'Decline extras', icon: CircleX, grain: 'parties', group: 'Review' },

  { command: 'audience.confirm_seats', label: 'Confirm seats', icon: CircleCheck, grain: 'parties', group: 'Allocation', options: 'override', params: { override: false } },
  { command: 'audience.promote', label: 'Promote from waitlist', icon: ListOrdered, grain: 'parties', group: 'Allocation' },
  { command: 'audience.waitlist', label: 'Waitlist', icon: Hourglass, grain: 'parties', group: 'Allocation' },
  { command: 'audience.move', label: 'Move to segment…', icon: ArrowRightLeft, grain: 'parties', group: 'Allocation', options: 'segment' },
  { command: 'audience.cancel', label: 'Cancel', icon: CircleX, grain: 'parties', group: 'Allocation', destructive: true },
  { command: 'audience.restore', label: 'Restore', icon: ArchiveRestore, grain: 'parties', group: 'Allocation', options: 'override', params: { override: false } },

  { command: 'audience.release', label: 'Release (treat as verified)', icon: UserCheck, grain: 'parties', group: 'Verification' },
  { command: 'audience.remind_verification', label: 'Send verification reminder', icon: BellRing, grain: 'parties', group: 'Verification' },

  { command: 'audience.check_address', label: 'Check address', icon: MailQuestion, grain: 'parties', group: 'Address' },
  { command: 'audience.accept_address', label: 'Accept address', icon: MailCheck, grain: 'parties', group: 'Address' },

  { command: 'audience.edit_field', label: 'Edit field…', icon: PencilLine, grain: 'parties', group: 'Records', options: 'edit-field', params: { field: 'round_label', value: null } },
  { command: 'audience.delete', label: 'Delete', icon: Trash2, grain: 'parties', group: 'Records', destructive: true },

  { command: 'seats.issue', label: 'Issue tickets', icon: Ticket, grain: 'seats', group: 'Tickets' },
  { command: 'seats.reissue', label: 'Reissue', icon: RefreshCw, grain: 'seats', group: 'Tickets' },
  { command: 'seats.dismiss_reissue', label: 'Dismiss reissue flag', icon: Eraser, grain: 'seats', group: 'Tickets' },
  { command: 'seats.void_qr', label: 'Void and re-issue QR', icon: ShieldAlert, grain: 'seats', group: 'Tickets', destructive: true },

  { command: 'delivery.send_tickets', label: 'Send tickets…', icon: Send, grain: 'parties', group: 'Delivery', wizard: true },
  { command: 'delivery.resend', label: 'Resend tickets…', icon: Repeat, grain: 'parties', group: 'Delivery', wizard: true },
  { command: 'delivery.mark_delivered', label: 'Mark delivered by hand', icon: HandHelping, grain: 'parties', group: 'Delivery' },
  { command: 'delivery.cancel_sending', label: 'Cancel sending', icon: MailX, grain: 'parties', group: 'Delivery' },

  // Messages (§24.4). Edit and Fix address open their own dialog (`messages/message-actions.tsx`).
  { command: 'messages.retry', label: 'Retry', icon: RotateCw, grain: 'messages', group: 'Messages' },
  { command: 'messages.resend', label: 'Resend', icon: Repeat, grain: 'messages', group: 'Messages' },
  { command: 'messages.cancel', label: 'Cancel', icon: Ban, grain: 'messages', group: 'Messages' },
  { command: 'messages.delete', label: 'Delete', icon: Trash2, grain: 'messages', group: 'Messages', destructive: true },

  { command: 'seats.check_in', label: 'Check in', icon: DoorOpen, grain: 'seats', group: 'Door' },
  { command: 'seats.undo_check_in', label: 'Undo check-in', icon: Undo2, grain: 'seats', group: 'Door' },

  { command: 'seats.set_status', label: 'Set status…', icon: Tags, grain: 'seats', group: 'Records', options: 'status', params: { status: 'CONFIRMED', override: false } },
  { command: 'seats.delete', label: 'Delete', icon: Trash2, grain: 'seats', group: 'Records', destructive: true },
];

export function entry(command: string): CommandEntry {
  const found = COMMAND_ENTRIES.find((e) => e.command === command);
  if (!found) throw new Error(`No Audience command ${command}`);
  return found;
}

export type HostData = {
  segments: { id: number; label: string }[];
  players: { id: number; label: string }[];
};

type Request = {
  command: string;
  selection: Selection<unknown>;
  params?: unknown;
  onDone?: () => void;
  /** The send wizard may skip its review steps (a one-party resend, §24.1). */
  reviewOptional?: boolean;
};

const HostContext = React.createContext<((request: Request) => void) | null>(null);

export function useRunCommand() {
  const run = React.useContext(HostContext);
  if (!run) throw new Error('useRunCommand needs a CommandHost above it.');
  return run;
}

export function CommandHost({
  concertId,
  data,
  children,
}: {
  concertId: number;
  data: HostData;
  children: React.ReactNode;
}) {
  const [active, setActive] = React.useState<(Request & { key: number }) | null>(null);
  const counter = React.useRef(0);

  const run = React.useCallback((request: Request) => {
    counter.current += 1;
    setActive({ ...request, key: counter.current });
  }, []);

  const current = active ? entry(active.command) : null;

  return (
    <HostContext.Provider value={run}>
      {children}
      {active && current?.wizard && (
        <SendWizard
          key={active.key}
          concertId={concertId}
          command={active.command as 'delivery.send_tickets' | 'delivery.resend'}
          selection={active.selection as Selection<AudienceFilter>}
          reviewOptional={active.reviewOptional}
          onDone={active.onDone}
          onClosed={() => setActive(null)}
        />
      )}
      {active && current && !current.wizard && (
        <CommandDialog
          key={active.key}
          concertId={concertId}
          command={active.command}
          selection={active.selection}
          params={active.params ?? current.params ?? {}}
          defaultOpen
          onDone={active.onDone}
          onClosed={() => setActive(null)}
          renderOptions={current.options ? (params, set) => <Options kind={current.options!} params={params} set={set} data={data} /> : undefined}
        />
      )}
    </HostContext.Provider>
  );
}

type AnyParams = Record<string, unknown>;

function OverrideSwitch({ params, set }: { params: AnyParams; set: (next: unknown) => void }) {
  const id = React.useId();
  return (
    <Field orientation="horizontal">
      <Switch
        id={id}
        checked={params.override === true}
        onCheckedChange={(checked: boolean) => set({ ...params, override: checked })}
      />
      <div className="flex flex-col gap-0.5">
        <FieldLabel htmlFor={id}>Go past capacity</FieldLabel>
        <FieldDescription>
          Seats that only fit past the segment, the hall or a player’s quota are granted anyway and
          flagged Over capacity. The preview below shows by how much.
        </FieldDescription>
      </div>
    </Field>
  );
}

function Options({
  kind,
  params: raw,
  set,
  data,
}: {
  kind: OptionsKind;
  params: unknown;
  set: (next: unknown) => void;
  data: HostData;
}) {
  const params = (raw ?? {}) as AnyParams;
  const id = React.useId();

  switch (kind) {
    case 'override':
      return <OverrideSwitch params={params} set={set} />;

    case 'include-flagged':
      return (
        <Field orientation="horizontal">
          <Switch
            id={id}
            checked={params.includeFlagged === true}
            onCheckedChange={(checked: boolean) => set({ ...params, includeFlagged: checked })}
          />
          <div className="flex flex-col gap-0.5">
            <FieldLabel htmlFor={id}>Include parties with flags</FieldLabel>
            <FieldDescription>
              Off by default: a flagged party — a possible duplicate, a suspicious address — is
              skipped so someone looks at it first.
            </FieldDescription>
          </div>
        </Field>
      );

    case 'segment':
      return (
        <>
          <Field>
            <FieldLabel htmlFor={id}>Move to</FieldLabel>
            <NativeSelect
              id={id}
              className="w-full"
              value={params.segmentId === undefined ? '' : String(params.segmentId)}
              onChange={(event) =>
                set(event.target.value ? { override: false, ...params, segmentId: Number(event.target.value) } : {})
              }
            >
              <NativeSelectOption value="">Choose a segment…</NativeSelectOption>
              {data.segments.map((segment) => (
                <NativeSelectOption key={segment.id} value={segment.id}>
                  {segment.label}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Field>
          {params.segmentId !== undefined && <OverrideSwitch params={params} set={set} />}
        </>
      );

    case 'status':
      return (
        <>
          <Field>
            <FieldLabel htmlFor={id}>New status</FieldLabel>
            <NativeSelect
              id={id}
              className="w-full"
              value={String(params.status ?? 'CONFIRMED')}
              onChange={(event) => set({ ...params, status: event.target.value })}
            >
              <NativeSelectOption value="CONFIRMED">Confirmed</NativeSelectOption>
              <NativeSelectOption value="PENDING_REVIEW">Waiting for review</NativeSelectOption>
              <NativeSelectOption value="WAITLIST">Waitlisted</NativeSelectOption>
              <NativeSelectOption value="CANCELLED">Cancelled</NativeSelectOption>
            </NativeSelect>
          </Field>
          {params.status === 'CONFIRMED' && <OverrideSwitch params={params} set={set} />}
        </>
      );

    case 'edit-field':
      return <EditFieldOptions params={params} set={set} data={data} />;
  }
}

function EditFieldOptions({
  params,
  set,
  data,
}: {
  params: AnyParams;
  set: (next: unknown) => void;
  data: HostData;
}) {
  const fieldId = React.useId();
  const valueId = React.useId();
  // The round is typed, so the preview waits until the admin stops typing.
  const [draft, setDraft] = React.useState(typeof params.value === 'string' ? params.value : '');
  return (
    <>
      <Field>
        <FieldLabel htmlFor={fieldId}>Field</FieldLabel>
        <NativeSelect
          id={fieldId}
          className="w-full"
          value={String(params.field)}
          onChange={(event) => {
            setDraft('');
            set({ field: event.target.value, value: null });
          }}
        >
          <NativeSelectOption value="round_label">Round</NativeSelectOption>
          <NativeSelectOption value="player_id">Player</NativeSelectOption>
        </NativeSelect>
      </Field>
      {params.field === 'round_label' ? (
        <Field>
          <FieldLabel htmlFor={valueId}>Round</FieldLabel>
          <Input
            id={valueId}
            value={draft}
            maxLength={200}
            placeholder="Blank clears it"
            onChange={(event) => setDraft(event.target.value)}
            onBlur={() => set({ field: 'round_label', value: draft.trim() || null })}
          />
        </Field>
      ) : (
        <Field>
          <FieldLabel htmlFor={valueId}>Player</FieldLabel>
          <NativeSelect
            id={valueId}
            className="w-full"
            value={params.value === null || params.value === undefined ? '' : String(params.value)}
            onChange={(event) =>
              set({ field: 'player_id', value: event.target.value ? Number(event.target.value) : null })
            }
          >
            <NativeSelectOption value="">No player</NativeSelectOption>
            {data.players.map((player) => (
              <NativeSelectOption key={player.id} value={player.id}>
                {player.label}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Field>
      )}
    </>
  );
}

export const GROUP_ICON: Record<CommandEntry['group'], LucideIcon> = {
  Review: ClipboardCheck,
  Allocation: ListOrdered,
  Verification: UserCheck,
  Address: MailQuestion,
  Tickets: Ticket,
  Delivery: Send,
  Messages: MailCheck,
  Door: DoorOpen,
  Records: PencilLine,
};
