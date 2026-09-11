'use client';

import { useId, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Ban, Pencil, RotateCcw, Trash2, Undo2 } from 'lucide-react';
import { Alert, AlertTitle } from '@/components/ui/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { Separator } from '@/components/ui/separator';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { ActionDialog } from '../../action-dialog';
import { DeleteButton } from '../shows/delete-button';
import type { FormState } from '../../form-state';
import {
  addAttendeesAction,
  cancelRegistrationAction,
  deleteRegistrationAction,
  moveRegistrationAction,
  removeAttendeeAction,
  renameAttendeeAction,
  restoreRegistrationAction,
} from './actions';
import { RegistrationFormDialog } from './registration-form-dialog';
import { STATUS_TONE } from './status';
import { OVERSELL_PHRASE } from '@/lib/registrations/confirmation';
import type {
  AttendeeRow,
  PlayerOption,
  RegistrationRow,
  SegmentOption,
} from './queries';

/**
 * One party, and everything §7.6 allows an admin to do to it.
 *
 * A `Sheet` rather than a `Dialog`: this is the "table + row actions + detail
 * sheet" pattern the admin console is built on (spec/surfaces.md §15.1), and a
 * party's seats are a list that wants height rather than a form that wants
 * focus.
 *
 * The seats are the point of the screen. Each one can be renamed or removed
 * individually, and the ticket state — delivered, needing reissue — is on the
 * row, because renaming a seat whose PDF is already in somebody's inbox is
 * exactly the edit that flags a reissue (spec/tickets.md §10.6).
 */
export function RegistrationSheet({
  concertId,
  timeZone,
  registration,
  attendees,
  segments,
  players,
  open,
  onOpenChange,
}: {
  concertId: number;
  timeZone: string | null;
  registration: RegistrationRow | null;
  /**
   * This party's seats, loaded with the page.
   *
   * A few hundred parties of two or three seats is one payload, so there is no
   * endpoint behind this sheet — which is one fewer route to authorize, and
   * `router.refresh()` after a mutation re-renders the page that produced them.
   */
  attendees: AttendeeRow[];
  segments: SegmentOption[];
  players: PlayerOption[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  if (!registration) return null;

  const cancelled = registration.status === 'CANCELLED';

  function run(action: () => Promise<FormState>) {
    setError(null);
    setNotice(null);
    return action().then((result) => {
      if (result.error) {
        setError(result.error);
      } else {
        setNotice(result.message ?? null);
        // The seats came from the page, so refreshing it is what updates them.
        router.refresh();
      }
      return result;
    });
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 sm:max-w-xl">
        <SheetHeader>
          <SheetTitle className="flex flex-wrap items-center gap-2">
            {registration.contactName}
            <Badge variant={STATUS_TONE[registration.status]}>
              {registration.status.replace('_', ' ').toLowerCase()}
            </Badge>
          </SheetTitle>
          <SheetDescription>
            {registration.showName} · {registration.segmentName}
            {registration.roundLabel ? ` · ${registration.roundLabel}` : ''} ·{' '}
            {registration.source.toLowerCase()}
          </SheetDescription>
        </SheetHeader>

        <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-4 pb-4">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-muted-foreground">Email</dt>
            <dd>{registration.contactEmail ?? '—'}</dd>
            <dt className="text-muted-foreground">Phone</dt>
            <dd>{registration.contactPhone ?? '—'}</dd>
            <dt className="text-muted-foreground">Player</dt>
            <dd>{registration.playerName ?? '—'}</dd>
            <dt className="text-muted-foreground">Requested</dt>
            <dd>{formatInZone(registration.requestedAt, timeZone)}</dd>
          </dl>

          {notice && (
            <Alert role="status">
              <AlertTitle className="text-sm leading-relaxed font-normal whitespace-pre-wrap">
                {notice}
              </AlertTitle>
            </Alert>
          )}
          {error && (
            <Alert variant="destructive" role="alert">
              <AlertTitle className="text-sm leading-relaxed font-normal whitespace-pre-wrap">
                {error}
              </AlertTitle>
            </Alert>
          )}

          <Separator />

          <section className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-medium">
                Seats
                <span className="text-muted-foreground ml-2 font-normal">
                  {registration.seats.confirmed} confirmed
                  {registration.seats.pending > 0 && `, ${registration.seats.pending} in review`}
                  {registration.seats.waitlisted > 0 && `, ${registration.seats.waitlisted} waiting`}
                </span>
              </h3>
              {!cancelled && (
                <AddSeatsDialog
                  concertId={concertId}
                  registration={registration}
                  maxTicketsPerResponse={
                    segments.find((s) => s.id === registration.segmentId)
                      ?.maxTicketsPerResponse ?? null
                  }
                  onDone={run}
                />
              )}
            </div>

            {attendees.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                This party holds no seats.
              </p>
            ) : (
              <ul className="flex flex-col gap-2">
                {attendees.map((attendee) => (
                  <SeatRow
                    key={attendee.id}
                    concertId={concertId}
                    attendee={attendee}
                    disabled={cancelled}
                    onDone={run}
                  />
                ))}
              </ul>
            )}
          </section>
        </div>

        <SheetFooter className="flex-row flex-wrap gap-2 border-t">
          <RegistrationFormDialog
            concertId={concertId}
            timeZone={timeZone}
            segments={segments}
            players={players}
            registration={registration}
            trigger={
              <Button variant="outline" size="sm">
                <Pencil /> Edit details
              </Button>
            }
          />

          <MoveDialog
            concertId={concertId}
            registration={registration}
            segments={segments}
            onDone={run}
          />

          {cancelled ? (
            <RestoreButton concertId={concertId} registrationId={registration.id} onDone={run} />
          ) : (
            <CancelButton
              contactName={registration.contactName}
              onConfirm={() =>
                run(() => cancelRegistrationAction(concertId, registration.id))
              }
            />
          )}

          {/*
            Delete sits apart from cancel because they are different facts, and
            the wording is the only thing stopping an admin reaching for the
            wrong one: cancelling says a real booking is not coming and keeps
            the record, deleting says the row should never have existed.

            `DeleteButton` keeps a refusal inside the dialog, which is what
            this needs — a party that has already been admitted is refused with
            a sentence naming how many, and closing the dialog would take the
            explanation with it.
          */}
          <DeleteButton
            trigger={
              <Button variant="ghost" size="sm" className="text-destructive ml-auto">
                <Trash2 /> Delete
              </Button>
            }
            title={`Delete ${registration.contactName}'s registration?`}
            description={
              <>
                This removes the booking and all {attendees.length} of its seat
                {attendees.length === 1 ? '' : 's'} from every screen, frees the seats, and
                withdraws any email still queued for it. Nothing in the admin console lists
                deleted registrations afterwards.
                <br />
                <br />
                If this is a real booking that is simply not coming, cancel it instead — a
                cancellation keeps the record and can be restored.
              </>
            }
            confirmLabel="Delete registration"
            action={() => deleteRegistrationAction(concertId, registration.id)}
          />
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}


/**
 * Cancelling, with somewhere for §7.9's answer to land.
 *
 * > Admin sees "N seats freed, M waiting".
 *
 * The shared `DeleteButton` renders `result.error` and closes on success, which
 * is right for a delete whose only interesting outcome is a refusal — but this
 * action's *success* is the interesting part, and routing it through that
 * component threw the sentence away. So the confirmation lives here and the
 * result goes back to the sheet, which shows it beside the seats it just freed.
 */
function CancelButton({
  contactName,
  onConfirm,
}: {
  contactName: string;
  onConfirm: () => Promise<FormState>;
}) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next: boolean) => {
        setOpen(next);
        if (!next) setError(null);
      }}
    >
      <AlertDialogTrigger
        render={
          <Button variant="destructive" size="sm">
            <Ban /> Cancel registration
          </Button>
        }
      />
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Cancel {contactName}?</AlertDialogTitle>
          <AlertDialogDescription>
            The seats return to the segment immediately and any queued email for this
            party is withdrawn. Tickets already delivered stay on record, so the door
            can say &ldquo;cancelled — refer to desk&rdquo; rather than &ldquo;not
            found&rdquo;. Nothing is promoted in their place — that is a separate,
            deliberate decision, because it sends email. It can be restored afterwards.
          </AlertDialogDescription>
        </AlertDialogHeader>

        {error && (
          <Alert variant="destructive" role="alert">
            <AlertTitle className="text-sm leading-relaxed font-normal whitespace-pre-wrap">
              {error}
            </AlertTitle>
          </Alert>
        )}

        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>Keep it</AlertDialogCancel>
          <AlertDialogAction
            nativeButton
            onClick={(event) => {
              event.preventDefault();
              startTransition(async () => {
                const result = await onConfirm();
                if (result.error) setError(result.error);
                else setOpen(false);
              });
            }}
            disabled={isPending}
          >
            {isPending && <Spinner />}
            Cancel registration
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** One seat: its name, what kind it is, and where its ticket has got to. */
function SeatRow({
  concertId,
  attendee,
  disabled,
  onDone,
}: {
  concertId: number;
  attendee: AttendeeRow;
  disabled: boolean;
  onDone: (action: () => Promise<FormState>) => Promise<FormState>;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(attendee.fullName);
  const [isPending, startTransition] = useTransition();

  function save() {
    startTransition(async () => {
      const data = new FormData();
      data.set('fullName', name);
      const result = await onDone(() =>
        renameAttendeeAction(concertId, attendee.id, { error: null }, data),
      );
      if (!result.error) setEditing(false);
    });
  }

  return (
    <li className="border-border flex items-center gap-2 rounded-md border p-2">
      {editing ? (
        <>
          <Input
            value={name === `Guest of ` ? '' : name}
            onChange={(event) => setName(event.target.value)}
            className="h-8 flex-1"
            aria-label="Seat name"
            autoFocus
          />
          <Button size="sm" onClick={save} disabled={isPending}>
            {isPending && <Spinner />} Save
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
            <Undo2 />
          </Button>
        </>
      ) : (
        <>
          {/* `min-w-0` and truncation, so a long placeholder name — "Guest of
              Wellington Mainwaring" — cannot push the row's own controls onto a
              second line. The full name is in the title attribute. */}
          <span className="min-w-0 flex-1 truncate text-sm" title={attendee.fullName}>
            {attendee.fullName}
            {attendee.namePlaceholder && (
              <span className="text-muted-foreground ml-2 text-xs">placeholder</span>
            )}
          </span>
          <Badge variant="outline" className="shrink-0">
            {attendee.allocationType.toLowerCase()}
          </Badge>
          <Badge variant={STATUS_TONE[attendee.status]} className="shrink-0">
            {attendee.status.replace('_', ' ').toLowerCase()}
          </Badge>
          {attendee.ticketSentAt && <Badge variant="secondary">sent</Badge>}
          {attendee.needsReissue && <Badge variant="destructive">reissue</Badge>}
          {!disabled && (
            <>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setEditing(true)}
                aria-label={`Rename ${attendee.fullName}`}
              >
                <Pencil />
              </Button>
              <DeleteButton
                trigger={
                  <Button size="sm" variant="ghost" aria-label={`Remove ${attendee.fullName}`}>
                    <Trash2 />
                  </Button>
                }
                title={`Remove ${attendee.fullName}?`}
                description="The seat returns to the segment. The row is kept, with its ticket code, so a ticket already delivered still resolves at the door."
                confirmLabel="Remove seat"
                action={() => removeAttendeeAction(concertId, attendee.id)}
              />
            </>
          )}
        </>
      )}
    </li>
  );
}

function AddSeatsDialog({
  concertId,
  registration,
  maxTicketsPerResponse,
  onDone,
}: {
  concertId: number;
  registration: RegistrationRow;
  /** The segment's resolved party cap, or null when none is configured. */
  maxTicketsPerResponse: number | null;
  onDone: (action: () => Promise<FormState>) => Promise<FormState>;
}) {
  const id = useId();
  const playerInvited = registration.audienceMode === 'PLAYER_INVITED';

  return (
    <ActionDialog
      trigger={
        <Button size="sm" variant="outline">
          Add seats
        </Button>
      }
      title="Add seats"
      description="Through the engine like any other grant, so a guest added after the segment filled waits rather than quietly appearing in a full room."
      submitLabel="Add seats"
      pendingLabel="Adding…"
      action={(formData) =>
        onDone(() => addAttendeesAction(concertId, registration.id, { error: null }, formData))
      }
    >
      <FieldGroup>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor={`${id}-seats`}>Seats</FieldLabel>
            {/* The segment's configured cap, or none — the action re-resolves
                and re-checks it against the seats this party already holds. */}
            <Input
              id={`${id}-seats`}
              name="seats"
              type="number"
              min={1}
              max={maxTicketsPerResponse ?? undefined}
              defaultValue={1}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={`${id}-type`}>Seat type</FieldLabel>
            <NativeSelect
              id={`${id}-type`}
              name="allocationType"
              defaultValue={playerInvited ? 'BASE' : 'EXTRA'}
            >
              {playerInvited && <option value="BASE">Base</option>}
              <option value="EXTRA">Extra</option>
              <option value="HELD">Held</option>
              <option value="COMP">Complimentary</option>
            </NativeSelect>
          </Field>
        </div>
        <Field>
          <FieldLabel htmlFor={`${id}-names`}>Guest names</FieldLabel>
          <Textarea id={`${id}-names`} name="guestNames" rows={3} placeholder="One name per line" />
          <FieldDescription>
            Optional — a seat with no name tickets as &ldquo;Guest of{' '}
            {registration.contactName}&rdquo;.
          </FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor={`${id}-override`}>
            Seat them even if the segment or hall is full
          </FieldLabel>
          <Input
            id={`${id}-override`}
            name="overrideConfirmation"
            autoComplete="off"
            placeholder={`Type ${OVERSELL_PHRASE} to allow it`}
          />
          <FieldDescription>
            Blank means a seat that does not fit waits instead (§7.6).
          </FieldDescription>
        </Field>
      </FieldGroup>
    </ActionDialog>
  );
}

function MoveDialog({
  concertId,
  registration,
  segments,
  onDone,
}: {
  concertId: number;
  registration: RegistrationRow;
  segments: SegmentOption[];
  /** Routes the result through the sheet, so "moved with N seats" is visible. */
  onDone: (action: () => Promise<FormState>) => Promise<FormState>;
}) {
  const id = useId();
  const elsewhere = segments.filter((option) => option.id !== registration.segmentId);

  return (
    <ActionDialog
      trigger={
        <Button variant="outline" size="sm">
          <RotateCcw /> Move
        </Button>
      }
      title={`Move ${registration.contactName}`}
      description="The party and every one of its seats move together, keeping their ticket codes. Moving to another show changes what the ticket says, so delivered ones are flagged for reissue."
      submitLabel="Move registration"
      pendingLabel="Moving…"
      action={(formData) =>
        onDone(() =>
          moveRegistrationAction(concertId, registration.id, { error: null }, formData),
        )
      }
    >
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor={`${id}-segment`}>Destination</FieldLabel>
          <NativeSelect id={`${id}-segment`} name="segmentId" required defaultValue="">
            <option value="" disabled>
              Choose a segment
            </option>
            {elsewhere.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </NativeSelect>
          <FieldDescription>
            Within this concert. A base seat moving into a public segment becomes an
            extra — a public segment owes nobody a base allocation.
          </FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor={`${id}-override`}>
            Move even if the destination has no room
          </FieldLabel>
          <Input
            id={`${id}-override`}
            name="overrideConfirmation"
            autoComplete="off"
            placeholder={`Type ${OVERSELL_PHRASE} to allow it`}
          />
          <FieldDescription>
            Blank means the move is refused when the destination is full (§7.6).
          </FieldDescription>
        </Field>
      </FieldGroup>
    </ActionDialog>
  );
}

function RestoreButton({
  concertId,
  registrationId,
  onDone,
}: {
  concertId: number;
  registrationId: number;
  onDone: (action: () => Promise<FormState>) => Promise<FormState>;
}) {
  const [isPending, startTransition] = useTransition();

  return (
    <Button
      size="sm"
      disabled={isPending}
      onClick={() =>
        startTransition(async () => {
          await onDone(() => restoreRegistrationAction(concertId, registrationId));
        })
      }
    >
      {isPending ? <Spinner /> : <Undo2 />} Restore
    </Button>
  );
}

/** Instants render in the concert's zone, never the viewer's (spec/domain.md §6.1). */
function formatInZone(value: Date, timeZone: string | null): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: timeZone ?? 'UTC',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(value);
}
