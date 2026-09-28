'use client';

import Link from 'next/link';
import { Copy, Merge, Split, Undo2 } from 'lucide-react';
import { useCanEdit } from '@/components/auth/role';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ButtonGroup } from '@/components/ui/button-group';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from '@/components/ui/item';
import type { RecordDuplicate } from '@/lib/audience/record';
import { useRunCommand } from '../command-host';

const REASON_LABEL: Record<string, string> = {
  EMAIL: 'same email',
  PHONE: 'same phone',
  NAME: 'similar name',
  MANUAL: 'marked by hand',
};

/**
 * Possible duplicates on the party record (spec/v3.md §25.5): each open pair
 * with why it matched and the other party at a glance, and the three
 * decisions — merge either way, or not a duplicate. A merge into this party
 * stays listed with *Undo merge* while it can still be undone.
 *
 * Every button is a command over the pair's id (§23.2), so the preview says
 * what will move before anything does.
 */
export function DuplicatesSection({
  concertId,
  partyName,
  duplicates,
  format,
}: {
  concertId: number;
  partyName: string;
  duplicates: RecordDuplicate[];
  format: Intl.DateTimeFormat;
}) {
  const runCommand = useRunCommand();
  const canEdit = useCanEdit();
  if (duplicates.length === 0) return null;

  const run = (command: string, pair: RecordDuplicate, params?: unknown) =>
    runCommand({ command, selection: { ids: [pair.candidateId] }, params });

  return (
    <section className="flex flex-col gap-3" aria-labelledby="duplicates-heading">
      <h2 id="duplicates-heading" className="text-base font-semibold">
        Possible duplicates
      </h2>
      <ItemGroup className="gap-2">
        {duplicates.map((pair) => {
          const keepThis = pair.thisIsA ? 'A' : 'B';
          const keepOther = pair.thisIsA ? 'B' : 'A';
          const other = pair.other;
          return (
            <Item key={pair.candidateId} variant="outline">
              <ItemMedia variant="icon">{pair.status === 'MERGED' ? <Merge /> : <Copy />}</ItemMedia>
              <ItemContent>
                <ItemTitle>
                  {pair.status === 'MERGED' ? (
                    <span>{other.name} was merged into this party</span>
                  ) : (
                    <Link
                      className="underline-offset-4 hover:underline"
                      href={`/admin/concerts/${concertId}/audience/${other.id}`}
                    >
                      {other.name}
                    </Link>
                  )}
                  {pair.reasons.map((reason) => (
                    <Badge key={reason} variant="secondary">
                      {REASON_LABEL[reason] ?? reason}
                      {reason === 'NAME' && pair.similarity !== null
                        ? ` ${Math.round(pair.similarity * 100)}%`
                        : ''}
                    </Badge>
                  ))}
                </ItemTitle>
                <ItemDescription>
                  {[
                    other.email,
                    other.phone,
                    `${other.segmentName}${other.playerName ? ` · invited by ${other.playerName}` : ''}`,
                    pair.status === 'MERGED'
                      ? pair.decidedAt
                        ? `merged ${format.format(new Date(pair.decidedAt))}`
                        : 'merged'
                      : `${other.liveSeats} seat${other.liveSeats === 1 ? '' : 's'}, requested ${format.format(new Date(other.requestedAt))}`,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </ItemDescription>
              </ItemContent>
              {canEdit && (
                <ItemActions>
                  {pair.status === 'MERGED' ? (
                    <Button size="sm" variant="outline" onClick={() => run('intake.undo_merge', pair)}>
                      <Undo2 data-icon="inline-start" />
                      Undo merge
                    </Button>
                  ) : (
                    <ButtonGroup>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => run('intake.merge', pair, { keep: keepThis, override: false })}
                        title={`${other.name}'s seats join ${partyName}`}
                      >
                        <Merge data-icon="inline-start" />
                        Merge into this party
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => run('intake.merge', pair, { keep: keepOther, override: false })}
                        title={`${partyName}'s seats join ${other.name}`}
                      >
                        Merge into {other.name}
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => run('intake.not_duplicate', pair)}>
                        <Split data-icon="inline-start" />
                        Not a duplicate
                      </Button>
                    </ButtonGroup>
                  )}
                </ItemActions>
              )}
            </Item>
          );
        })}
      </ItemGroup>
    </section>
  );
}
