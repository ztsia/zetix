'use client';

import { useState, useTransition } from 'react';
import { CircleAlertIcon, CircleCheckIcon, PlusIcon, Trash2Icon } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';
import { FormCard } from '@/components/forms/form-surface';
import type { EditableResponse } from '@/lib/registrations/edit';
import { requestExtraSeatsAction, saveEditAction } from './actions';

/**
 * The edit screen (spec/v2.md §8.3.1).
 *
 * **This does not use `FormRenderer`, and the reason is the seat list.** `K`'s
 * handoff expected the edit screen among its consumers, and for the flat scope
 * that would be right — but a repeater's rows are positional, and an edit needs
 * each row bound to a specific `attendee_id` that survives removing the row
 * above it. Index-based identity here means editing the wrong person's name.
 *
 * The second reason is the rule itself: a repeater has an "add" control, and on
 * this screen adding must be **structurally impossible** rather than capped at
 * the current row count. A cap is a number that can be wrong; not having the
 * control is not.
 *
 * Custom questions are deliberately not re-offered here. §8.3.1 permits editing
 * them, and the honest way to do that is through the renderer against the
 * pinned schema — which is the same positional problem for repeaters and a
 * genuinely larger piece of work. Recorded in the handoff rather than
 * half-built: a registrant who needs a custom answer changed contacts the
 * orchestra, which is the same route §8.3.1 gives them once tickets are sent.
 */

export function EditResponseForm({
  editToken,
  response,
}: {
  editToken: string;
  response: EditableResponse;
}) {
  const [token, setToken] = useState(editToken);
  const [contactName, setContactName] = useState(response.contactName);
  const [contactPhone, setContactPhone] = useState(response.contactPhone ?? '');
  const [seats, setSeats] = useState(
    response.seats.map((seat) => ({
      attendeeId: seat.attendeeId,
      fullName: seat.fullName,
      email: seat.email ?? '',
      removed: false,
    })),
  );
  const [extraNames, setExtraNames] = useState<string[]>([]);
  const [note, setNote] = useState<{ ok: boolean; message: string } | null>(null);
  const [pending, startTransition] = useTransition();

  const kept = seats.filter((seat) => !seat.removed);

  const save = () => {
    setNote(null);
    startTransition(async () => {
      const raw = {
        contact_name: contactName,
        contact_phone: contactPhone,
        seats: kept.map((seat) => ({ full_name: seat.fullName, email: seat.email })),
      };
      const result = await saveEditAction(token, {
        contactName,
        contactPhone: contactPhone || null,
        custom: null,
        seats: kept.map((seat) => ({
          attendeeId: seat.attendeeId,
          fullName: seat.fullName,
          email: seat.email || null,
        })),
        raw,
      });
      setNote({ ok: result.ok, message: result.message });
      if (result.ok) {
        /**
         * **The token rotates on every edit.** Each edit inserts a new
         * `form_responses` row and only the newest is editable, so the page has
         * to hold the new token or a second save in the same visit would be
         * refused as superseded.
         */
        if (result.editToken) setToken(result.editToken);
        setSeats((current) => current.filter((seat) => !seat.removed));
      }
    });
  };

  const requestExtras = () => {
    setNote(null);
    startTransition(async () => {
      const result = await requestExtraSeatsAction(
        token,
        extraNames.filter((name) => name.trim() !== ''),
      );
      setNote({ ok: result.ok, message: result.message });
      if (result.ok) setExtraNames([]);
    });
  };

  // One card per part, on the form canvas, like the form this edits.
  return (
    <div className="flex flex-col gap-3">
      {note ? (
        <Alert variant={note.ok ? 'default' : 'destructive'}>
          {note.ok ? <CircleCheckIcon /> : <CircleAlertIcon />}
          <AlertTitle>{note.ok ? 'Saved' : 'Not saved'}</AlertTitle>
          <AlertDescription>{note.message}</AlertDescription>
        </Alert>
      ) : null}

      <FormCard className="flex flex-col gap-4">
        <h2 className="text-base font-medium">Your details</h2>
        <div className="flex flex-col gap-2">
          <Label htmlFor="contact-name">Full name</Label>
          <Input
            id="contact-name"
            value={contactName}
            onChange={(event) => setContactName(event.target.value)}
            disabled={pending}
          />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="contact-phone">Phone (optional)</Label>
          <Input
            id="contact-phone"
            value={contactPhone}
            onChange={(event) => setContactPhone(event.target.value)}
            disabled={pending}
          />
        </div>
        {/*
          The email is shown and not editable. Changing the address a
          registration is keyed to is a different operation from correcting a
          name: it re-opens verification, moves the outbox's addressee, and on a
          form with `one_response_per_identity` it moves the identity the unique
          index is built on. That belongs to admin (§7.6), not to a link anyone
          holding the URL can use.
        */}
        <div className="flex flex-col gap-2">
          <Label>Email</Label>
          <Input value={response.contactEmail} readOnly disabled />
          <p className="text-xs text-muted-foreground">
            To change the address your tickets go to, please contact the orchestra.
          </p>
        </div>
      </FormCard>

      <FormCard className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <h2 className="text-base font-medium">
            Your seats ({kept.length})
          </h2>
          <p className="text-xs text-muted-foreground">
            Correct a name, or release a seat you no longer need. Released seats go back to the pool
            straight away.
          </p>
        </div>

        {seats.map((seat, index) =>
          seat.removed ? null : (
            <div key={seat.attendeeId} className="flex flex-col gap-2 rounded-md border p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium text-muted-foreground">Seat {index + 1}</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={pending || kept.length === 1}
                  onClick={() =>
                    setSeats((current) =>
                      current.map((s) =>
                        s.attendeeId === seat.attendeeId ? { ...s, removed: true } : s,
                      ),
                    )
                  }
                >
                  <Trash2Icon data-icon="inline-start" />
                  Release
                </Button>
              </div>
              <Input
                aria-label={`Seat ${index + 1} name`}
                value={seat.fullName}
                onChange={(event) =>
                  setSeats((current) =>
                    current.map((s) =>
                      s.attendeeId === seat.attendeeId
                        ? { ...s, fullName: event.target.value }
                        : s,
                    ),
                  )
                }
                disabled={pending}
              />
              <Input
                aria-label={`Seat ${index + 1} email`}
                placeholder="Their email (optional)"
                value={seat.email}
                onChange={(event) =>
                  setSeats((current) =>
                    current.map((s) =>
                      s.attendeeId === seat.attendeeId ? { ...s, email: event.target.value } : s,
                    ),
                  )
                }
                disabled={pending}
              />
            </div>
          ),
        )}

        {/*
          The last seat cannot be released. Emptying a party here would leave a
          CONFIRMED registration holding nothing, which every count in the
          system would have to special-case — and "I am not coming at all" is a
          cancellation, which is a different decision and an admin's.
        */}
        {kept.length === 1 ? (
          <p className="text-xs text-muted-foreground">
            To cancel the registration entirely, please contact the orchestra.
          </p>
        ) : null}

        <Button type="button" onClick={save} disabled={pending} size="lg">
          {pending ? <Spinner data-icon="inline-start" /> : null}
          Save changes
        </Button>
      </FormCard>

      {/*
        The offer that replaces adding a guest (§8.3.1). It is visually and
        functionally separate from Save, because it is a different thing: a new
        request with a new `requested_at`, at the back of the queue.
      */}
      <FormCard className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <h2 className="text-base font-medium">Need more seats?</h2>
          <p className="text-xs text-muted-foreground">
            Extra seats cannot be added to a registration you have already made. Requesting them
            joins the queue at today&rsquo;s date, and we will let you know either way.
          </p>
        </div>

        {extraNames.map((name, index) => (
          <div key={index} className="flex gap-2">
            <Input
              aria-label={`Extra guest ${index + 1}`}
              placeholder="Guest name"
              value={name}
              onChange={(event) =>
                setExtraNames((current) =>
                  current.map((n, i) => (i === index ? event.target.value : n)),
                )
              }
              disabled={pending}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              disabled={pending}
              onClick={() => setExtraNames((current) => current.filter((_, i) => i !== index))}
            >
              <Trash2Icon />
              <span className="sr-only">Remove</span>
            </Button>
          </div>
        ))}

        <div className="flex flex-col gap-2 sm:flex-row">
          <Button
            type="button"
            variant="outline"
            disabled={pending}
            onClick={() => setExtraNames((current) => [...current, ''])}
          >
            <PlusIcon data-icon="inline-start" />
            Add a name
          </Button>
          {extraNames.length > 0 ? (
            <Button type="button" variant="secondary" onClick={requestExtras} disabled={pending}>
              {pending ? <Spinner data-icon="inline-start" /> : null}
              Request {extraNames.length} extra seat{extraNames.length === 1 ? '' : 's'}
            </Button>
          ) : null}
        </div>
      </FormCard>
    </div>
  );
}
