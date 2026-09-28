'use client';

import { useId, useState, type ReactNode } from 'react';
import { ActionDialog } from '../../action-dialog';
import { CascadeHint } from '../../cascade-hint';
import { toLocalInput } from '../../local-time';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import type { FormState } from '../../form-state';
import type { SegmentView } from './queries';
import { createSegmentAction, updateSegmentAction } from './actions';

type AudienceMode = 'PLAYER_INVITED' | 'PUBLIC';

/**
 * Create or edit a segment — a slice of one show's capacity with its own
 * audience model (spec/domain.md §5.1, spec/allocation.md §7.1).
 *
 * **This is where allocation is configured.** Every formula in §7.2 is
 * evaluated per segment, never per show, so capacity, quota, deadline and
 * policy all live on this form and none of them on the show's.
 *
 * Base quota is shown only for a player-invited audience. A public segment has
 * no players to promise seats to, so a quota there is a number that reads as a
 * promise and entitles nobody — the action refuses one outright.
 */
export function SegmentFormDialog({
  concertId,
  showId,
  segment,
  timeZone,
  availableModes,
  trigger,
}: {
  concertId: number;
  showId: number;
  /** Absent when creating. */
  segment?: SegmentView;
  timeZone: string | null;
  /** Modes this show does not already hold — `unique (show_id, audience_mode)`. */
  availableModes: AudienceMode[];
  trigger: ReactNode;
}) {
  const id = useId();
  const editing = segment !== undefined;
  const modes = editing ? ([segment.audienceMode] as AudienceMode[]) : availableModes;
  const [mode, setMode] = useState<AudienceMode>(
    segment?.audienceMode ?? modes[0] ?? 'PUBLIC',
  );

  const action = (formData: FormData): Promise<FormState> =>
    editing
      ? updateSegmentAction(concertId, segment.id, { error: null }, formData)
      : createSegmentAction(concertId, showId, { error: null }, formData);

  return (
    <ActionDialog
      trigger={trigger}
      title={editing ? `Edit ${segment.name}` : 'New segment'}
      description="A slice of this show's capacity with its own audience, quota and policy."
      submitLabel={editing ? 'Save segment' : 'Add segment'}
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
            defaultValue={segment?.name ?? ''}
            placeholder={mode === 'PUBLIC' ? 'Public' : 'Player invited'}
          />
        </Field>

        <Field>
          <FieldLabel htmlFor={`${id}-audience`}>Audience</FieldLabel>
          <NativeSelect
            id={`${id}-audience`}
            name="audienceMode"
            value={mode}
            onChange={(event) => setMode(event.target.value as AudienceMode)}
            // Changing a segment's audience after registrations exist would
            // reinterpret every seat in it; the mode is fixed once created.
            disabled={editing}
          >
            {modes.map((value) => (
              <option key={value} value={value}>
                {value === 'PUBLIC' ? 'Public' : 'Player invited'}
              </option>
            ))}
          </NativeSelect>
          {editing ? (
            <FieldDescription>
              A segment&rsquo;s audience is fixed once it exists — every seat in it was
              allocated under these rules.
            </FieldDescription>
          ) : (
            <FieldDescription>
              A show holds at most one segment of each audience, and can hold both at
              once.
            </FieldDescription>
          )}
        </Field>

        <Field>
          <FieldLabel htmlFor={`${id}-capacity`}>Capacity</FieldLabel>
          <Input
            id={`${id}-capacity`}
            name="capacity"
            type="number"
            min={0}
            inputMode="numeric"
            defaultValue={segment?.raw.capacity ?? ''}
          />
          <CascadeHint resolved={segment?.resolved['segment.capacity']} level="segment" />
        </Field>

        {mode === 'PLAYER_INVITED' && (
          <>
            <Field>
              <FieldLabel htmlFor={`${id}-quota`}>Base quota per player</FieldLabel>
              <Input
                id={`${id}-quota`}
                name="baseQuota"
                type="number"
                min={0}
                inputMode="numeric"
                defaultValue={segment?.raw.baseQuota ?? ''}
              />
              {/* Raising this is one of the three routes the §7.4 guard watches;
                  the database refuses and names the shortfall. */}
              <CascadeHint
                resolved={segment?.resolved['allocation.base_quota']}
                level="segment"
              />
            </Field>

            <Field>
              <FieldLabel htmlFor={`${id}-deadline`}>Base claim deadline</FieldLabel>
              <Input
                id={`${id}-deadline`}
                name="baseClaimDeadline"
                type="datetime-local"
                disabled={!timeZone}
                defaultValue={toLocalInput(segment?.raw.baseClaimDeadline, timeZone)}
              />
              <FieldDescription>
                After this, unclaimed base seats release into this segment&rsquo;s extras
                pool.
              </FieldDescription>
            </Field>
          </>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor={`${id}-policy`}>Extras policy</FieldLabel>
            <NativeSelect
              id={`${id}-policy`}
              name="extrasPolicy"
              defaultValue={segment?.raw.extrasPolicy ?? ''}
            >
              <option value="">Inherit</option>
              <option value="REVIEW">Review — grant in batch</option>
              <option value="AUTO_FCFS">Auto — first come, first served</option>
            </NativeSelect>
            <CascadeHint
              resolved={segment?.resolved['allocation.extras_policy']}
              level="segment"
            />
          </Field>

          <Field>
            <FieldLabel htmlFor={`${id}-partial`}>Partial grants</FieldLabel>
            <NativeSelect
              id={`${id}-partial`}
              name="allowPartialGrant"
              defaultValue={triStateValue(segment?.raw.allowPartialGrant)}
            >
              <option value="">Inherit</option>
              <option value="true">Allowed</option>
              <option value="false">Not allowed</option>
            </NativeSelect>
            <FieldDescription>
              Whether a request at the boundary of the pool may be granted in part.
            </FieldDescription>
          </Field>

          <Field>
            <FieldLabel htmlFor={`${id}-approve`}>Approve clean parties</FieldLabel>
            <NativeSelect
              id={`${id}-approve`}
              name="autoApproveClean"
              defaultValue={triStateValue(segment?.raw.autoApproveClean)}
            >
              <option value="">Inherit</option>
              <option value="true">Automatically, at submit</option>
              <option value="false">By hand, in review</option>
            </NativeSelect>
            <CascadeHint resolved={segment?.resolved['review.auto_approve_clean']} level="segment" />
          </Field>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor={`${id}-party`}>Max tickets per response</FieldLabel>
            <Input
              id={`${id}-party`}
              name="maxTicketsPerResponse"
              type="number"
              min={0}
              inputMode="numeric"
              defaultValue={segment?.raw.maxTicketsPerResponse ?? ''}
            />
            <CascadeHint
              resolved={segment?.resolved['form.max_tickets_per_response']}
              level="segment"
            />
          </Field>

          <Field>
            <FieldLabel htmlFor={`${id}-order`}>Display order</FieldLabel>
            <Input
              id={`${id}-order`}
              name="displayOrder"
              type="number"
              inputMode="numeric"
              defaultValue={segment?.displayOrder ?? 0}
            />
          </Field>
        </div>
      </FieldGroup>
    </ActionDialog>
  );
}

/** null is "inherit", which is a third state a checkbox cannot express. */
function triStateValue(value: boolean | null | undefined): string {
  if (value === null || value === undefined) return '';
  return value ? 'true' : 'false';
}
