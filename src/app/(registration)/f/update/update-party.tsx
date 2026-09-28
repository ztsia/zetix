'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { CircleAlertIcon, CircleCheckIcon, MailIcon, UsersIcon } from 'lucide-react';
import { FormCard, FormHeaderCard } from '@/components/forms/form-surface';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import type { UpdatableParty } from '@/lib/intake/party-update';
import type { UpdateOutcome } from '@/lib/intake/party-update';
import { changeEmailAction, giveBackSeatsAction, nameGuestsAction } from './actions';

const STATUS: Record<UpdatableParty['seats'][number]['status'], string> = {
  CONFIRMED: 'Confirmed',
  PENDING_REVIEW: 'Awaiting review',
  WAITLIST: 'Waitlisted',
};

/**
 * The party update page (spec/v3.md §25.6): name guests, correct the address,
 * give back seats. Three separate saves, because they are three different
 * acts — and giving seats back cannot be undone from here, so it asks first.
 */
export function UpdateParty({ token, party, when }: { token: string; party: UpdatableParty; when: string | null }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [outcome, setOutcome] = useState<UpdateOutcome | null>(null);

  const [names, setNames] = useState<Record<number, string>>(() =>
    Object.fromEntries(party.seats.map((seat) => [seat.id, seat.unnamed ? '' : seat.fullName])),
  );
  const [returning, setReturning] = useState<Set<number>>(new Set());
  const [confirmReturn, setConfirmReturn] = useState(false);
  const [email, setEmail] = useState(party.contactEmail ?? '');
  const [addressConfirmed, setAddressConfirmed] = useState(false);

  const run = (action: () => Promise<UpdateOutcome>, after?: (result: UpdateOutcome) => void) =>
    startTransition(async () => {
      const result = await action();
      setOutcome(result);
      after?.(result);
      if (result.ok) router.refresh();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });

  const unnamed = party.seats.filter((seat) => seat.unnamed).length;
  const everyone = returning.size === party.seats.length;

  return (
    <div className="flex flex-col gap-3">
      <FormHeaderCard
        title={`${party.contactName}, your registration`}
        description={
          <p>
            {party.showName}
            {when ? ` · ${when}` : ''}. {party.seats.length} seat{party.seats.length === 1 ? '' : 's'}
            {unnamed > 0 ? `, ${unnamed} still to be named` : ''}.
          </p>
        }
      />

      {outcome ? (
        <Alert variant={outcome.ok ? 'default' : 'destructive'} role="status">
          {outcome.ok ? <CircleCheckIcon /> : <CircleAlertIcon />}
          <AlertTitle>{outcome.ok ? 'Done' : 'Not saved'}</AlertTitle>
          <AlertDescription>{outcome.message}</AlertDescription>
        </Alert>
      ) : null}

      {!party.verified ? (
        <Alert>
          <MailIcon />
          <AlertTitle>Please confirm your email address</AlertTitle>
          <AlertDescription>
            Open the confirmation link we sent to {party.contactEmail}. Your tickets are sent once it is confirmed.
          </AlertDescription>
        </Alert>
      ) : null}

      <FormCard>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            run(() =>
              nameGuestsAction(
                token,
                party.seats
                  .filter((seat) => !seat.admitted)
                  .map((seat) => ({ attendeeId: seat.id, fullName: names[seat.id] ?? '' })),
              ),
            );
          }}
        >
          <div className="flex items-center gap-2">
            <UsersIcon className="size-5" aria-hidden />
            <h2 className="text-lg font-medium">Your guests</h2>
          </div>
          <FieldGroup>
            {party.seats.map((seat, index) => (
              <Field key={seat.id}>
                <FieldLabel htmlFor={`seat-${seat.id}`} className="flex flex-wrap items-center gap-2">
                  Guest {index + 1}
                  <Badge variant="secondary">{STATUS[seat.status]}</Badge>
                  {seat.admitted ? <Badge variant="outline">Inside</Badge> : null}
                </FieldLabel>
                <Input
                  id={`seat-${seat.id}`}
                  value={names[seat.id] ?? ''}
                  placeholder={seat.unnamed ? 'Their full name' : undefined}
                  disabled={pending || seat.admitted}
                  onChange={(event) => setNames({ ...names, [seat.id]: event.target.value })}
                />
                <label className="text-muted-foreground flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={returning.has(seat.id)}
                    disabled={pending || seat.admitted}
                    onCheckedChange={(checked: boolean) => {
                      const next = new Set(returning);
                      if (checked) next.add(seat.id);
                      else next.delete(seat.id);
                      setReturning(next);
                    }}
                  />
                  This guest can no longer come — give the seat back
                </label>
              </Field>
            ))}
          </FieldGroup>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={pending}>
              {pending ? <Spinner /> : null}
              Save names
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={pending || returning.size === 0}
              onClick={() => setConfirmReturn(true)}
            >
              Give back {returning.size > 0 ? returning.size : ''} seat{returning.size === 1 ? '' : 's'}
            </Button>
          </div>
        </form>
      </FormCard>

      <AlertDialog open={confirmReturn} onOpenChange={setConfirmReturn}>
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {everyone ? 'Cancel your registration?' : `Give back ${returning.size} seat${returning.size === 1 ? '' : 's'}?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {everyone
                ? 'Every seat goes back to the room and your tickets stop working. This cannot be undone here.'
                : 'The seats go to the next people waiting, and their tickets stop working. This cannot be undone here.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep them</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirmReturn(false);
                run(
                  () => giveBackSeatsAction(token, [...returning]),
                  (result) => result.ok && setReturning(new Set()),
                );
              }}
            >
              Give back
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <FormCard>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            run(
              () => changeEmailAction(token, email, addressConfirmed),
              (result) => {
                if (!result.ok && result.addressWarning) setAddressConfirmed(true);
              },
            );
          }}
        >
          <Field>
            <FieldLabel htmlFor="contact-email">Email address</FieldLabel>
            <Input
              id="contact-email"
              type="email"
              value={email}
              disabled={pending}
              onChange={(event) => {
                setEmail(event.target.value);
                setAddressConfirmed(false);
              }}
            />
            <FieldDescription>
              Your tickets are sent here. If you change it, we send a link to the new address to confirm it.
            </FieldDescription>
          </Field>
          <div>
            <Button type="submit" variant="outline" disabled={pending || email.trim() === ''}>
              Change email
            </Button>
          </div>
        </form>
      </FormCard>

      <p className="text-muted-foreground pb-6 text-xs">
        Need more seats? Fill in the registration form again with the same email address — they join this
        registration as a new request.
      </p>
    </div>
  );
}
