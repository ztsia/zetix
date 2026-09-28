'use client';

import { CalendarClock, MapPin, Pencil, Plus, Shuffle, Trash2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Empty, EmptyDescription, EmptyTitle } from '@/components/ui/empty';
import { Separator } from '@/components/ui/separator';
import { OriginBadge } from '../../cascade-hint';
import { formatShowTime } from '../../local-time';
import { deleteSegmentAction, deleteShowAction } from './actions';
import { DeleteButton } from './delete-button';
import { MoveCapacityDialog } from './move-capacity-dialog';
import { SegmentDeliveryDialog } from './segment-delivery-dialog';
import { SegmentFormDialog } from './segment-form-dialog';
import { GenerateFeedbackButton } from './generate-feedback-button';
import { ShowFormDialog } from './show-form-dialog';
import type { SegmentView, ShowView } from './queries';
import type { FormFunnel } from '@/lib/intake/funnel';
import { SegmentForms } from '../forms/form-funnel';
import { AdminOnly } from '@/components/auth/role';

const STATUS_VARIANT: Record<ShowView['status'], 'default' | 'secondary' | 'outline'> = {
  OPEN: 'default',
  DRAFT: 'secondary',
  CLOSED: 'outline',
  COMPLETED: 'outline',
};

/**
 * One show, its segments and its capacity accounting.
 *
 * The card leads with the hall arithmetic because that is the question this
 * screen exists to answer: how many seats the room holds, how they are split,
 * and how many are held back. Held seats are simply seats in no segment — there
 * is no `held_seats` column and no soft threshold (decision 21).
 */
export function ShowCard({
  concertId,
  show,
  timeZone,
  forms = [],
  appUrl = null,
}: {
  concertId: number;
  show: ShowView;
  timeZone: string | null;
  /** This show's registration forms and their funnels (spec/v3.md §25.6). */
  forms?: FormFunnel[];
  appUrl?: string | null;
}) {
  const hall = show.resolved['capacity'];
  const usedModes = new Set(show.segments.map((segment) => segment.audienceMode));
  const availableModes = (['PLAYER_INVITED', 'PUBLIC'] as const).filter(
    (mode) => !usedModes.has(mode),
  );
  const startsAt = formatShowTime(show.startsAt, timeZone);
  const doorsOpenAt = formatShowTime(show.doorsOpenAt, timeZone);

  return (
    <Card>
      <CardHeader className="gap-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-base font-semibold">{show.name}</h2>
              <Badge variant={STATUS_VARIANT[show.status]}>
                {show.status.toLowerCase()}
              </Badge>
            </div>

            <div className="text-muted-foreground mt-1 flex flex-col gap-0.5 text-sm">
              {startsAt ? (
                <span className="flex items-center gap-1.5">
                  <CalendarClock className="size-3.5 shrink-0" />
                  {startsAt}
                  {doorsOpenAt && ` · doors ${doorsOpenAt.split(', ').pop()}`}
                </span>
              ) : (
                <span className="flex items-center gap-1.5">
                  <CalendarClock className="size-3.5 shrink-0" />
                  No date set
                </span>
              )}
              {show.venueName && (
                <span className="flex items-center gap-1.5">
                  <MapPin className="size-3.5 shrink-0" />
                  {show.venueName}
                </span>
              )}
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            <ShowFormDialog
              concertId={concertId}
              show={show}
              timeZone={timeZone}
              trigger={
                <Button variant="outline" size="sm">
                  <Pencil />
                  Edit show
                </Button>
              }
            />
            <DeleteButton
              trigger={
                <Button variant="ghost" size="icon" aria-label={`Remove ${show.name}`}>
                  <Trash2 />
                </Button>
              }
              title={`Remove ${show.name}?`}
              description="Its segments go with it. This is refused while anyone holds a confirmed seat — nothing that has been ticketed can be removed out from under the people holding it."
              confirmLabel="Remove show"
              action={() => deleteShowAction(concertId, show.id)}
            />
          </div>
        </div>

        {/*
          * The audience only exists once the evening is over, so the control
          * appears with the status that says so (spec/v2.md §13.5.3).
          */}
        {show.status === 'COMPLETED' ? (
          <AdminOnly>
            <GenerateFeedbackButton concertId={concertId} showId={show.id} />
          </AdminOnly>
        ) : null}

        <CapacityBar show={show} hallOrigin={hall} />
      </CardHeader>

      <CardContent className="flex flex-col gap-3">
        <Separator />

        {show.segments.length === 0 ? (
          <Empty className="py-6">
            <EmptyTitle>No segments yet</EmptyTitle>
            <EmptyDescription>
              A segment is a slice of this hall with its own audience. Allocation is
              computed per segment, so nothing can be registered until there is one.
            </EmptyDescription>
          </Empty>
        ) : (
          <ul className="flex flex-col gap-3">
            {show.segments.map((segment) => (
              <li key={segment.id}>
                <SegmentRow
                  concertId={concertId}
                  showId={show.id}
                  segment={segment}
                  timeZone={timeZone}
                  forms={forms.filter((form) => form.segmentId === segment.id)}
                  appUrl={appUrl}
                />
              </li>
            ))}
          </ul>
        )}

        <div className="flex flex-wrap gap-2">
          {availableModes.length > 0 && (
            <SegmentFormDialog
              concertId={concertId}
              showId={show.id}
              timeZone={timeZone}
              availableModes={[...availableModes]}
              trigger={
                <Button variant="outline" size="sm">
                  <Plus />
                  Add segment
                </Button>
              }
            />
          )}
          {show.segments.length > 0 && (
            <MoveCapacityDialog
              concertId={concertId}
              show={show}
              trigger={
                <Button variant="outline" size="sm">
                  <Shuffle />
                  Move capacity
                </Button>
              }
            />
          )}
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * Hall, allocated and held, as one line.
 *
 * `held` is null when the hall itself is unset — rendering 0 there would read as
 * "none held" rather than "nobody has said how big the room is", and those need
 * different actions from the admin.
 */
function CapacityBar({
  show,
  hallOrigin,
}: {
  show: ShowView;
  hallOrigin: ShowView['resolved'][string] | undefined;
}) {
  if (show.held === null) {
    return (
      <p className="text-muted-foreground text-sm">
        No capacity set for this hall yet — segments cannot be checked against it until
        there is one.
      </p>
    );
  }

  const hall = show.allocated + show.held;
  const over = show.held < 0;

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
      <span>
        Hall <span className="font-medium tabular-nums">{hall}</span>
      </span>
      <span className="text-muted-foreground">
        allocated <span className="tabular-nums">{show.allocated}</span>
      </span>
      <span className={over ? 'text-destructive font-medium' : 'text-muted-foreground'}>
        {over ? (
          <>
            <span className="tabular-nums">{-show.held}</span> over the hall
          </>
        ) : (
          <>
            <span className="tabular-nums">{show.held}</span> held back
          </>
        )}
      </span>
      <OriginBadge resolved={hallOrigin} />
    </div>
  );
}

/** One segment: what it is configured as, and what the engine currently counts. */
function SegmentRow({
  concertId,
  showId,
  segment,
  timeZone,
  forms,
  appUrl,
}: {
  concertId: number;
  showId: number;
  segment: SegmentView;
  timeZone: string | null;
  forms: FormFunnel[];
  appUrl: string | null;
}) {
  const { pool } = segment;

  return (
    <div className="flex flex-wrap items-start justify-between gap-3 rounded-md border px-3 py-2.5">
      <div className="min-w-0 space-y-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{segment.name}</span>
          <Badge variant="secondary">
            {segment.audienceMode === 'PUBLIC' ? 'public' : 'player invited'}
          </Badge>
          <OriginBadge resolved={segment.resolved['segment.capacity']} />
        </div>

        {/* A segment with no capacity at any level has no pool to report — the
            engine refuses to invent one, and this is the normal state between
            adding a segment and configuring it. Say so rather than printing
            zeros, which would read as a full house. */}
        {pool === null ? (
          <p className="text-muted-foreground text-sm">
            No capacity set — nothing can be allocated here yet.
          </p>
        ) : (
          <div className="text-muted-foreground flex flex-wrap gap-x-4 gap-y-1 text-sm">
            <span>
              <span className="tabular-nums">{pool.sellable}</span> seats
            </span>
            <span>
              <span className="tabular-nums">{pool.confirmed}</span> confirmed
            </span>
            {/* `over` rather than a negative `open_seats`: an admin override can
                push confirmed past capacity, and the screen must say "full, N
                over" rather than print a negative (spec/allocation.md §7.2). */}
            {pool.over > 0 ? (
              <span className="text-destructive font-medium">
                full, <span className="tabular-nums">{pool.over}</span> over
              </span>
            ) : (
              <span>
                <span className="tabular-nums">{pool.extras_pool}</span> in the extras
                pool
              </span>
            )}
            {segment.audienceMode === 'PLAYER_INVITED' && (
              <span>
                <span className="tabular-nums">{pool.unclaimed_base}</span> base unclaimed
                {pool.base_released && ' (released)'}
              </span>
            )}
          </div>
        )}

        {/* Its forms, on their parent (spec/v3.md §25.6). */}
        <SegmentForms concertId={concertId} forms={forms} appUrl={appUrl} />
      </div>

      <div className="flex shrink-0 items-center gap-1">
        {/* The ticket design and email Send tickets starts from (spec/v3.md §24.2). */}
        <SegmentDeliveryDialog concertId={concertId} segmentId={segment.id} segmentName={segment.name} />
        <SegmentFormDialog
          concertId={concertId}
          showId={showId}
          segment={segment}
          timeZone={timeZone}
          availableModes={[segment.audienceMode]}
          trigger={
            // Named for the segment: two "Edit" buttons on one show are
            // indistinguishable to a screen reader, and to anyone driving the
            // page by keyboard.
            <Button variant="ghost" size="sm" aria-label={`Edit ${segment.name}`}>
              <Pencil />
              Edit
            </Button>
          }
        />
        <DeleteButton
          trigger={
            <Button variant="ghost" size="icon" aria-label={`Remove ${segment.name}`}>
              <Trash2 />
            </Button>
          }
          title={`Remove ${segment.name}?`}
          description="This is refused while the segment still holds confirmed seats — removing it would leave those people holding tickets to nothing."
          confirmLabel="Remove segment"
          action={() => deleteSegmentAction(concertId, segment.id)}
        />
      </div>
    </div>
  );
}
