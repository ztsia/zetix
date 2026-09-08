'use client';

import { useId, useState, type ReactNode } from 'react';
import { ActionDialog } from '../../action-dialog';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import type { FormState } from '../../form-state';
import type { ShowView } from './queries';
import { moveCapacityAction } from './actions';

/**
 * Move capacity between the segments of one show (spec/allocation.md §7.7).
 *
 * **Every segment is on this form at once, and they save together.** That is the
 * point of the screen rather than a convenience: the guards are deferred
 * constraint triggers that judge the state at `COMMIT`, so "player 100 → 80"
 * followed by "public 300 → 320" is rejected on the first step, while the same
 * pair in one transaction commits. Editing the two segments through their own
 * forms genuinely cannot express this edit.
 *
 * Segments never borrow from each other automatically — that would make the
 * number of people arriving at the door unpredictable, which is the one number
 * front of house has to trust. This is the explicit admin edit that replaces
 * automatic borrowing, and it is written to `audit_log`.
 */
export function MoveCapacityDialog({
  concertId,
  show,
  trigger,
}: {
  concertId: number;
  show: ShowView;
  trigger: ReactNode;
}) {
  const id = useId();
  const [values, setValues] = useState<Record<number, string>>(() =>
    Object.fromEntries(
      // A segment with no capacity yet starts blank rather than at zero:
      // pre-filling 0 would let a distracted save pin a real zero.
      show.segments.map((segment) => [
        segment.id,
        segment.pool === null ? '' : String(segment.pool.sellable),
      ]),
    ),
  );

  const hall = show.resolved['capacity']?.value;
  const hallSeats = typeof hall === 'number' ? hall : Number(hall ?? Number.NaN);

  const total = show.segments.reduce((sum, segment) => {
    const entered = Number(values[segment.id]);
    return sum + (Number.isFinite(entered) ? entered : 0);
  }, 0);
  const remaining = Number.isFinite(hallSeats) ? hallSeats - total : null;

  const action = (formData: FormData): Promise<FormState> => {
    const moves = show.segments.map((segment) => {
      const raw = String(formData.get(`capacity-${segment.id}`) ?? '').trim();
      return {
        segmentId: segment.id,
        capacity: raw === '' ? null : Number(raw),
      };
    });
    const reason = String(formData.get('reason') ?? '').trim();
    return moveCapacityAction(concertId, show.id, moves, reason === '' ? null : reason);
  };

  return (
    <ActionDialog
      trigger={trigger}
      title={`Move capacity — ${show.name}`}
      description="Every segment saves together, as one edit. Raising one without lowering another is fine so long as the total still fits the hall — that spends held seats, which is what they are for."
      submitLabel="Save capacities"
      pendingLabel="Saving…"
      action={action}
    >
      <FieldGroup>
        {show.segments.map((segment) => (
          <Field key={segment.id}>
            <FieldLabel htmlFor={`${id}-${segment.id}`}>
              {segment.name}{' '}
              <span className="text-muted-foreground font-normal">
                ({segment.audienceMode === 'PUBLIC' ? 'public' : 'player invited'})
              </span>
            </FieldLabel>
            <Input
              id={`${id}-${segment.id}`}
              name={`capacity-${segment.id}`}
              type="number"
              min={0}
              inputMode="numeric"
              value={values[segment.id] ?? ''}
              onChange={(event) =>
                setValues((prev) => ({ ...prev, [segment.id]: event.target.value }))
              }
            />
            <FieldDescription>
              {segment.pool === null
                ? 'No capacity set yet.'
                : `${segment.pool.confirmed} confirmed`}
              {/* The floor on lowering: the database refuses to shed seats
                  people already hold, and saying so here saves a round trip. */}
              {segment.pool !== null &&
                segment.pool.confirmed > 0 &&
                ` — it cannot go below ${segment.pool.confirmed}`}
            </FieldDescription>
          </Field>
        ))}

        <div className="bg-muted/40 rounded-md border px-3 py-2 text-sm">
          {remaining === null ? (
            <span className="text-muted-foreground">
              This show has no capacity set, so there is no hall to fit these inside yet.
            </span>
          ) : (
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="text-muted-foreground">
                Hall {hallSeats} · allocated <span className="tabular-nums">{total}</span>
              </span>
              <span
                className={
                  remaining < 0 ? 'text-destructive font-medium' : 'text-muted-foreground'
                }
              >
                {remaining < 0
                  ? `${-remaining} over the hall`
                  : `${remaining} held back`}
              </span>
            </div>
          )}
        </div>

        <Field>
          <FieldLabel htmlFor={`${id}-reason`}>Reason</FieldLabel>
          <Textarea
            id={`${id}-reason`}
            name="reason"
            rows={2}
            placeholder="Player segment closed with seats unclaimed."
          />
          <FieldDescription>
            Recorded in the audit log beside the numbers. Optional, but the numbers
            alone rarely explain themselves a month later.
          </FieldDescription>
        </Field>
      </FieldGroup>
    </ActionDialog>
  );
}
