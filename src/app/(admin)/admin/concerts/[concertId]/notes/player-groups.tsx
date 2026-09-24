'use client';

import { useState, useTransition } from 'react';
import { DownloadIcon, MailIcon, UsersIcon } from 'lucide-react';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';
import { NoteCard } from './notes-board';
import { queueDigestAction } from './actions';
import type { PlayerGroup } from './queries';

/**
 * §14.2's grouped view — "a collapsible section per player with every note
 * addressed to them and a count".
 *
 * **Admin-only, always** (decision 6), whatever `portal.public_wall_visibility`
 * says. It is why this component lives under `(admin)` and has no counterpart
 * in `components/portal/`: there is no configuration that opens it, so there is
 * no code path to open.
 *
 * This is the view that prepares what goes back to players, so the two actions
 * that do that are here and nowhere else: queue a digest, and export.
 */

export function PlayerGroups({
  concertId,
  groups,
}: {
  concertId: number;
  groups: PlayerGroup[];
}) {
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [state, setState] = useState<{ error: string | null; message?: string | null }>({
    error: null,
  });
  const [pending, startTransition] = useTransition();

  /** The orchestra group has no player and therefore no digest to queue. */
  const addressable = groups.filter((g) => g.playerId !== null);
  const chosen = [...selected];

  function queue(playerIds: number[]) {
    startTransition(async () => {
      const result = await queueDigestAction(concertId, playerIds);
      setState(result);
      if (!result.error) setSelected(new Set());
    });
  }

  if (groups.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <UsersIcon />
          </EmptyMedia>
          <EmptyTitle>Nobody has been written to yet</EmptyTitle>
          <EmptyDescription>
            A section appears here for each player the audience addresses a note to.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {state.error ? (
        <Alert variant="destructive">
          <AlertTitle>Nothing was queued</AlertTitle>
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}
      {state.message ? (
        <Alert>
          <MailIcon />
          <AlertDescription>{state.message}</AlertDescription>
        </Alert>
      ) : null}

      <div className="flex flex-wrap items-center gap-3 rounded-md border bg-muted/40 px-3 py-2">
        <Checkbox
          id="select-players"
          checked={addressable.length > 0 && addressable.every((g) => selected.has(g.playerId!))}
          onCheckedChange={(on) =>
            setSelected(on ? new Set(addressable.map((g) => g.playerId!)) : new Set())
          }
          disabled={addressable.length === 0}
        />
        <Label htmlFor="select-players" className="text-sm font-normal">
          {chosen.length === 0
            ? `${addressable.length} ${addressable.length === 1 ? 'player' : 'players'} written to`
            : `${chosen.length} selected`}
        </Label>

        <div className="ml-auto flex gap-2">
          {/*
            * Export is a link rather than an action: the route streams a file
            * and a Server Action cannot. It carries the current selection so
            * "export these players' notes" and "export all of them" are the
            * same control (§14.2).
            */}
          <a
            className={buttonVariants({ variant: 'outline', size: 'sm' })}
            href={`/api/notes/export?concertId=${concertId}${
              chosen.length > 0 ? `&playerIds=${chosen.join(',')}` : ''
            }`}
          >
            <DownloadIcon />
            Export CSV
          </a>
          <Button
            size="sm"
            disabled={pending || chosen.length === 0}
            onClick={() => queue(chosen)}
          >
            {pending ? <Spinner data-icon="inline-start" /> : <MailIcon />}
            Queue digest
          </Button>
        </div>
      </div>

      {/* Base UI's accordion opens multiple panels by default, so there is no
          `type` prop to set — a player's section stays open while another is
          read, which is how a batch of digests gets prepared. */}
      <Accordion className="w-full">
        {groups.map((group) => {
          const key = group.playerId === null ? 'orchestra' : String(group.playerId);
          return (
            <AccordionItem key={key} value={key}>
              <div className="flex items-center gap-3">
                {group.playerId !== null ? (
                  <Checkbox
                    checked={selected.has(group.playerId)}
                    onCheckedChange={(on) =>
                      setSelected((prev) => {
                        const next = new Set(prev);
                        if (on) next.add(group.playerId!);
                        else next.delete(group.playerId!);
                        return next;
                      })
                    }
                    aria-label={`Select ${group.playerName}`}
                  />
                ) : (
                  /* Keeps the headings aligned where the orchestra group has no box. */
                  <span className="size-4" aria-hidden />
                )}
                <AccordionTrigger className="flex-1">
                  <span className="flex flex-wrap items-center gap-2">
                    {group.playerName}
                    <Badge variant="secondary">{group.notes.length}</Badge>
                    {group.digestPending ? <Badge variant="outline">Digest waiting</Badge> : null}
                    {group.playerId !== null && !group.playerEmail ? (
                      <Badge variant="destructive">No email</Badge>
                    ) : null}
                  </span>
                </AccordionTrigger>
              </div>
              <AccordionContent>
                <div className="grid gap-3 pt-1">
                  {group.notes.map((note) => (
                    <NoteCard key={note.id} note={note} />
                  ))}
                </div>
              </AccordionContent>
            </AccordionItem>
          );
        })}
      </Accordion>
    </div>
  );
}
