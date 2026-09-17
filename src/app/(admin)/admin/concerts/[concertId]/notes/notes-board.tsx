'use client';

import { useMemo, useState, useTransition } from 'react';
import { CheckIcon, EyeOffIcon, QuoteIcon, RotateCcwIcon, UploadIcon } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ButtonGroup } from '@/components/ui/button-group';
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import type { AdminNote } from './queries';
import { moderateNotesAction, setNotesOnWallAction } from './actions';

/**
 * §14.2's wall view: "approved notes as cards, filterable by show, player,
 * moderation and wall status".
 *
 * **Cards rather than the shared `DataTable`, and that is a departure worth
 * stating.** `CLAUDE.md`'s conventions list notes among `DataTable`'s
 * consumers; §14.2 says cards, and `modules-v2.md` §4 settles which wins —
 * where the spec and the module map disagree about behaviour, the spec does.
 * The reason is legible in the data: a note is a paragraph of prose, and the
 * thing an admin does on this screen is *read* it and decide. A table row
 * truncates the one column that matters. The convention's purpose — not six
 * inconsistent tables — is untouched, because this is not a table.
 *
 * **The filters include moderation status, so this is every note and not only
 * the approved ones.** §14.2's opening phrase describes what the wall ends up
 * holding; the filter list describes what the screen must show to get there.
 */

type Moderation = AdminNote['moderationStatus'];
type Wall = AdminNote['wallStatus'];
const ALL = 'all';

export function NotesBoard({
  concertId,
  notes,
  shows,
  players,
}: {
  concertId: number;
  notes: AdminNote[];
  shows: { id: number; name: string }[];
  players: { id: number; name: string }[];
}) {
  const [showId, setShowId] = useState<string>(ALL);
  const [playerId, setPlayerId] = useState<string>(ALL);
  const [moderation, setModeration] = useState<string>(ALL);
  const [wall, setWall] = useState<string>(ALL);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [state, setState] = useState<{ error: string | null; message?: string | null }>({
    error: null,
  });
  const [pending, startTransition] = useTransition();

  const filtered = useMemo(
    () =>
      notes.filter((note) => {
        if (showId !== ALL && note.showId !== Number(showId)) return false;
        if (playerId === 'orchestra' && note.toPlayerId !== null) return false;
        if (playerId !== ALL && playerId !== 'orchestra' && note.toPlayerId !== Number(playerId)) {
          return false;
        }
        if (moderation !== ALL && note.moderationStatus !== moderation) return false;
        if (wall !== ALL && note.wallStatus !== wall) return false;
        return true;
      }),
    [notes, showId, playerId, moderation, wall],
  );

  /**
   * **Selection is kept across a filter change, not cleared.** Narrowing to one
   * show, ticking three, then widening to check something is an ordinary way to
   * work, and losing the three is the kind of small betrayal that makes an
   * admin stop trusting bulk actions. The count below always names the total so
   * nothing is selected invisibly.
   */
  const chosen = [...selected];
  const visibleIds = filtered.map((n) => n.id);
  const allVisibleChosen = visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));

  function toggle(id: number, on: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function run(action: () => Promise<{ error: string | null; message?: string | null }>) {
    startTransition(async () => {
      const result = await action();
      setState(result);
      /**
       * The selection survives a refusal on purpose: `setNotesOnWallAction`
       * refuses the whole call when the selection contains a note written to a
       * player, and the admin needs those notes still selected to find and
       * deselect them.
       */
      if (!result.error) setSelected(new Set());
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <Filter label="Show" value={showId} onChange={setShowId} allLabel="All shows">
          {shows.map((s) => (
            <SelectItem key={s.id} value={String(s.id)}>
              {s.name}
            </SelectItem>
          ))}
        </Filter>

        <Filter label="Written to" value={playerId} onChange={setPlayerId} allLabel="Anyone">
          <SelectItem value="orchestra">The whole orchestra</SelectItem>
          {players.map((p) => (
            <SelectItem key={p.id} value={String(p.id)}>
              {p.name}
            </SelectItem>
          ))}
        </Filter>

        <Filter label="Review" value={moderation} onChange={setModeration} allLabel="Any">
          <SelectItem value="PENDING">Waiting</SelectItem>
          <SelectItem value="APPROVED">Approved</SelectItem>
          <SelectItem value="HIDDEN">Hidden</SelectItem>
        </Filter>

        <Filter label="Wall" value={wall} onChange={setWall} allLabel="Any">
          <SelectItem value="PUBLISHED">On the wall</SelectItem>
          <SelectItem value="NOT_PUBLISHED">Not published</SelectItem>
        </Filter>
      </div>

      {state.error ? (
        <Alert variant="destructive">
          <AlertTitle>Nothing was changed</AlertTitle>
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}
      {state.message ? (
        <Alert>
          <CheckIcon />
          <AlertDescription>{state.message}</AlertDescription>
        </Alert>
      ) : null}

      <div className="flex flex-wrap items-center gap-3 rounded-md border bg-muted/40 px-3 py-2">
        <Checkbox
          id="select-visible"
          checked={allVisibleChosen}
          onCheckedChange={(on) =>
            setSelected((prev) => {
              const next = new Set(prev);
              for (const id of visibleIds) {
                if (on) next.add(id);
                else next.delete(id);
              }
              return next;
            })
          }
          disabled={visibleIds.length === 0}
        />
        <Label htmlFor="select-visible" className="text-sm font-normal">
          {chosen.length === 0
            ? `${filtered.length} shown`
            : `${chosen.length} selected of ${notes.length}`}
        </Label>

        <ButtonGroup className="ml-auto">
          <Button
            variant="outline"
            size="sm"
            disabled={pending || chosen.length === 0}
            onClick={() => run(() => moderateNotesAction(concertId, chosen, 'APPROVED'))}
          >
            {pending ? <Spinner data-icon="inline-start" /> : <CheckIcon />}
            Approve
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={pending || chosen.length === 0}
            onClick={() => run(() => moderateNotesAction(concertId, chosen, 'HIDDEN'))}
          >
            <EyeOffIcon />
            Hide
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={pending || chosen.length === 0}
            onClick={() => run(() => setNotesOnWallAction(concertId, chosen, true))}
          >
            <UploadIcon />
            Publish
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={pending || chosen.length === 0}
            onClick={() => run(() => setNotesOnWallAction(concertId, chosen, false))}
          >
            <RotateCcwIcon />
            Unpublish
          </Button>
        </ButtonGroup>
      </div>

      {filtered.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <QuoteIcon />
            </EmptyMedia>
            <EmptyTitle>{notes.length === 0 ? 'No notes yet' : 'Nothing matches'}</EmptyTitle>
            <EmptyDescription>
              {notes.length === 0
                ? 'Notes appear here as the audience leaves them in the portal.'
                : 'No note matches the current filters.'}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="grid gap-3">
          {filtered.map((note) => (
            <NoteCard
              key={note.id}
              note={note}
              checked={selected.has(note.id)}
              onCheckedChange={(on) => toggle(note.id, on)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function Filter({
  label,
  value,
  onChange,
  allLabel,
  children,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  allLabel: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid gap-1.5">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      {/* Base UI hands back `null` when a select is cleared; these four never
          are, and `ALL` is the neutral option rather than an absent value. */}
      <Select value={value} onValueChange={(next: string | null) => onChange(next ?? ALL)}>
        <SelectTrigger className="w-[11rem]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>{allLabel}</SelectItem>
          {children}
        </SelectContent>
      </Select>
    </div>
  );
}

/**
 * One note, rendered as §14.2 renders it: `"{body}" — from {display_name}`, or
 * Anonymous.
 *
 * **Anonymity is shown, not applied.** §13.4 hides the name on the wall and
 * never from admin, so the writer's own name is always here — the badge says
 * the wall will not carry it. An admin preparing a digest needs to know who
 * wrote what even when the audience will not.
 */
export function NoteCard({
  note,
  checked,
  onCheckedChange,
}: {
  note: AdminNote;
  checked?: boolean;
  onCheckedChange?: (on: boolean) => void;
}) {
  return (
    <Card>
      <CardHeader className="flex-row items-start gap-3 space-y-0">
        {onCheckedChange ? (
          <Checkbox
            checked={checked}
            onCheckedChange={(on) => onCheckedChange(on === true)}
            aria-label={`Select the note from ${note.attendeeName}`}
            className="mt-1"
          />
        ) : null}
        <div className="grid gap-1">
          <CardTitle className="text-sm font-medium">
            {note.toPlayerName ? `To ${note.toPlayerName}` : 'For the orchestra'}
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            {note.showName} · from {note.attendeeName}
          </p>
        </div>
      </CardHeader>

      <CardContent>
        <blockquote className="border-l-2 pl-3 text-sm whitespace-pre-wrap">
          {note.body}
        </blockquote>
        <p className="mt-2 text-xs text-muted-foreground">
          — {note.displayName ?? note.attendeeName}
          {note.isAnonymous ? ' (shown as Anonymous)' : ''}
        </p>
      </CardContent>

      <CardFooter className="gap-2">
        <ModerationBadge status={note.moderationStatus} />
        {note.wallStatus === 'PUBLISHED' ? <Badge>On the wall</Badge> : null}
        {note.toPlayerId !== null ? <Badge variant="outline">Personal</Badge> : null}
      </CardFooter>
    </Card>
  );
}

function ModerationBadge({ status }: { status: Moderation }) {
  if (status === 'APPROVED') return <Badge variant="secondary">Approved</Badge>;
  if (status === 'HIDDEN') return <Badge variant="destructive">Hidden</Badge>;
  return <Badge variant="outline">Waiting</Badge>;
}

export type { Moderation, Wall };
