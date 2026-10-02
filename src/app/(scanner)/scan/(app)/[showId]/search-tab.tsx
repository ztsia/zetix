'use client';

import { useMemo, useState } from 'react';
import { Search, X } from 'lucide-react';
import type { ManifestEntry, ManifestIndex } from '@/lib/checkin/manifest';
import { searchManifest } from '@/lib/checkin/search';
import { admittedKeys, type LocalCheckIn } from '@/lib/checkin/evaluate';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from '@/components/ui/input-group';
import { Item, ItemActions, ItemContent, ItemDescription, ItemTitle } from '@/components/ui/item';
import { Badge } from '@/components/ui/badge';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';

/**
 * Name and ticket-code lookup (spec/ref.md §1.2, spec/tickets.md §10.1 rule 4).
 *
 * **Not optional.** At a real door several people per hundred cannot present a
 * scannable code — a cracked screen, a ticket printed too small, a dead phone —
 * and without this tab the queue stops. It runs against the same offline
 * manifest the camera does, so it is the way in that survives having neither a
 * camera nor a network.
 */
export function SearchTab({
  index,
  checkIns,
  onSelect,
}: {
  index: ManifestIndex;
  checkIns: readonly LocalCheckIn[];
  onSelect: (entry: ManifestEntry) => void;
}) {
  const [query, setQuery] = useState('');
  const hits = useMemo(() => searchManifest(index, query), [index, query]);
  const admitted = useMemo(() => admittedKeys(index, checkIns), [index, checkIns]);

  return (
    <div className="flex h-full flex-col gap-3 p-4">
      <InputGroup>
        <InputGroupInput
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Name or ticket code"
          // A door is not the place for the OS to second-guess a surname or a
          // Crockford code. All four are needed: iOS ignores some in isolation.
          autoCapitalize="off"
          autoCorrect="off"
          autoComplete="off"
          spellCheck={false}
          enterKeyHint="search"
          aria-label="Search by name or ticket code"
          className="h-12 text-base"
        />
        <InputGroupAddon>
          <Search className="size-4" />
        </InputGroupAddon>
        {query.length > 0 && (
          <InputGroupAddon align="inline-end">
            <InputGroupButton size="icon-sm" aria-label="Clear" onClick={() => setQuery('')}>
              <X />
            </InputGroupButton>
          </InputGroupAddon>
        )}
      </InputGroup>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {query.trim().length === 0 ? (
          <Empty className="h-full">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Search />
              </EmptyMedia>
              <EmptyTitle>Search the roster</EmptyTitle>
              <EmptyDescription>
                Works with no camera and no signal — {index.entries.length} tickets are on this
                device.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : hits.length === 0 ? (
          <Empty className="h-full">
            <EmptyHeader>
              <EmptyTitle>Nobody matches “{query}”</EmptyTitle>
              <EmptyDescription>
                Try a surname, or the code printed on the ticket. If they are certain they
                registered, send them to the desk.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <ul className="flex flex-col gap-2">
            {hits.map((hit) => (
              <li key={index.keyOf(hit.entry)}>
                <Item
                  variant="outline"
                  // 64px of target: this is tapped one-handed, at speed, by
                  // someone also holding a stack of programmes.
                  className="min-h-16"
                  render={<button type="button" onClick={() => onSelect(hit.entry)} />}
                >
                  <ItemContent>
                    <ItemTitle className="text-base">{hit.entry.name}</ItemTitle>
                    <ItemDescription>
                      {hit.entry.ticketCode ?? 'No code issued'}
                      {hit.entry.playerName ? ` · Guest of ${hit.entry.playerName}` : ''}
                    </ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    {hit.entry.status === 'CANCELLED' ? (
                      <Badge variant="destructive">Cancelled</Badge>
                    ) : admitted.has(index.keyOf(hit.entry)) ? (
                      <Badge variant="secondary">In</Badge>
                    ) : null}
                  </ItemActions>
                </Item>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
