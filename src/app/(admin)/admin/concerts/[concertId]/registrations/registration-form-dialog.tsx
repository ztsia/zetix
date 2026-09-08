'use client';

import { useId, useState, type ReactNode } from 'react';
import { ActionDialog } from '../../action-dialog';
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import type { FormState } from '../../form-state';
import { toLocalInput } from '../../local-time';
import { createRegistrationAction, updateRegistrationAction } from './actions';
import type { PlayerOption, RegistrationRow, SegmentOption } from './queries';

/**
 * Create a registration by hand, or edit the details of one that exists
 * (spec/allocation.md §7.6).
 *
 * > Players registering after the form closes are expected, not exceptional.
 *
 * So this form never asks whether a form is open: it lists every segment of the
 * concert and lets the admin pick one. What the party actually gets is still the
 * engine's decision — base seats while the player is owed them, extras held for
 * review in a `REVIEW` segment, and anything that does not fit waiting.
 *
 * **Editing does not change the seats.** Contact details, the player link, the
 * round and the request time are all this can touch; seats are added and removed
 * in the detail sheet, one at a time, where each is visible.
 */
export function RegistrationFormDialog({
  concertId,
  timeZone,
  segments,
  players,
  registration,
  trigger,
}: {
  concertId: number;
  timeZone: string | null;
  segments: SegmentOption[];
  players: PlayerOption[];
  /** Absent when creating. */
  registration?: RegistrationRow;
  trigger: ReactNode;
}) {
  const id = useId();
  const editing = registration !== undefined;
  const [segmentId, setSegmentId] = useState(
    String(registration?.segmentId ?? segments[0]?.id ?? ''),
  );

  const segment = segments.find((option) => String(option.id) === segmentId);
  const playerInvited = segment?.audienceMode === 'PLAYER_INVITED';

  const action = (formData: FormData): Promise<FormState> =>
    editing
      ? updateRegistrationAction(concertId, registration.id, { error: null }, formData)
      : createRegistrationAction(concertId, { error: null }, formData);

  return (
    <ActionDialog
      trigger={trigger}
      title={editing ? `Edit ${registration.contactName}` : 'New registration'}
      description={
        editing
          ? 'Contact details, the player link and the request time. Seats are edited seat by seat, below the details.'
          : 'A party of one email and N seats, created against any segment — form windows do not apply to the admin.'
      }
      submitLabel={editing ? 'Save registration' : 'Create registration'}
      pendingLabel="Saving…"
      action={action}
    >
      <FieldGroup>
        {!editing && (
          <Field>
            <FieldLabel htmlFor={`${id}-segment`}>Segment</FieldLabel>
            <NativeSelect
              id={`${id}-segment`}
              name="segmentId"
              required
              value={segmentId}
              onChange={(event) => setSegmentId(event.target.value)}
            >
              {segments.length === 0 && <option value="">No segments yet</option>}
              {segments.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </NativeSelect>
            <FieldDescription>
              The segment owns the audience and the allocation; the show owns the hall.
              Every segment of this concert is listed, open or closed.
            </FieldDescription>
          </Field>
        )}

        <Field>
          <FieldLabel htmlFor={`${id}-contact`}>Contact name</FieldLabel>
          <Input
            id={`${id}-contact`}
            name="contactName"
            required
            autoFocus
            maxLength={200}
            defaultValue={registration?.contactName ?? ''}
          />
          <FieldDescription>
            A seat with no name of its own tickets as &ldquo;Guest of {'{'}this name{'}'}&rdquo;.
          </FieldDescription>
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor={`${id}-email`}>Contact email</FieldLabel>
            <Input
              id={`${id}-email`}
              name="contactEmail"
              type="email"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              defaultValue={registration?.contactEmail ?? ''}
            />
            <FieldDescription>
              Where this party&rsquo;s tickets go — one message carrying every PDF.
            </FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor={`${id}-phone`}>Phone</FieldLabel>
            <Input
              id={`${id}-phone`}
              name="contactPhone"
              defaultValue={registration?.contactPhone ?? ''}
            />
          </Field>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor={`${id}-player`}>Player</FieldLabel>
            <NativeSelect
              id={`${id}-player`}
              name="playerId"
              defaultValue={registration?.playerId ? String(registration.playerId) : ''}
            >
              <option value="">Not a player&rsquo;s registration</option>
              {players.map((player) => (
                <option key={player.id} value={player.id}>
                  {player.label}
                </option>
              ))}
            </NativeSelect>
            <FieldDescription>
              What a base seat is drawn against. Only active players are entitled.
            </FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor={`${id}-round`}>Round</FieldLabel>
            <Input
              id={`${id}-round`}
              name="roundLabel"
              placeholder="Round 1"
              defaultValue={registration?.roundLabel ?? ''}
            />
            <FieldDescription>
              Groups the blast and the exports by round.
            </FieldDescription>
          </Field>
        </div>

        <Field>
          <FieldLabel htmlFor={`${id}-requested`}>Requested at</FieldLabel>
          <Input
            id={`${id}-requested`}
            name="requestedAt"
            type="datetime-local"
            defaultValue={toLocalInput(registration?.requestedAt, timeZone)}
          />
          <FieldDescription>
            The order the extras review walks in, in the concert&rsquo;s own timezone.
            Leave it blank for now — but a request that arrived last week should say so,
            or it goes to the back of a queue it belongs in the middle of.
          </FieldDescription>
        </Field>

        {!editing && (
          <>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor={`${id}-seats`}>Seats</FieldLabel>
                <Input
                  id={`${id}-seats`}
                  name="seats"
                  type="number"
                  min={1}
                  max={50}
                  defaultValue={1}
                  required
                />
              </Field>
              <Field>
                <FieldLabel htmlFor={`${id}-type`}>Seat type</FieldLabel>
                <NativeSelect
                  id={`${id}-type`}
                  name="allocationType"
                  defaultValue={playerInvited ? 'BASE' : 'EXTRA'}
                  key={playerInvited ? 'player' : 'public'}
                >
                  {playerInvited && <option value="BASE">Base — a player&rsquo;s own entitlement</option>}
                  <option value="EXTRA">Extra — from the extras pool</option>
                  <option value="HELD">Held</option>
                  <option value="COMP">Complimentary</option>
                </NativeSelect>
                <FieldDescription>
                  {playerInvited
                    ? 'Base seats confirm while the player is still owed them.'
                    : 'A public segment owes nobody a base seat.'}
                </FieldDescription>
              </Field>
            </div>

            <Field>
              <FieldLabel htmlFor={`${id}-names`}>Guest names</FieldLabel>
              <Textarea
                id={`${id}-names`}
                name="guestNames"
                rows={4}
                placeholder={'One name per line\nLeave a line out and that seat tickets as a placeholder'}
              />
              <FieldDescription>
                Optional. Names are matched to seats in order; a seat with no name is
                not an error.
              </FieldDescription>
            </Field>

            <Field orientation="horizontal">
              <Checkbox id={`${id}-override`} name="override" value="on" />
              <FieldContentLabel htmlFor={`${id}-override`}>
                Seat this party even if the segment or the hall is full
              </FieldContentLabel>
            </Field>
            <FieldDescription>
              Only the ceiling is overridable, and only deliberately — the override is
              recorded in the audit log with this party&rsquo;s name.
            </FieldDescription>
          </>
        )}
      </FieldGroup>
    </ActionDialog>
  );
}

/** A label that sits beside its control rather than above it. */
function FieldContentLabel({
  htmlFor,
  children,
}: {
  htmlFor: string;
  children: ReactNode;
}) {
  return (
    <FieldLabel htmlFor={htmlFor} className="font-normal">
      {children}
    </FieldLabel>
  );
}
