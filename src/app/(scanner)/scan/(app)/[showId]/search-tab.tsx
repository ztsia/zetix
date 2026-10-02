'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  CircleCheck,
  CircleDashed,
  CircleDot,
  CircleSlash,
  Search,
  TicketX,
  UserPlus,
  X,
} from 'lucide-react';
import type { ManifestEntry, ManifestIndex } from '@/lib/checkin/manifest';
import { searchParties, type PartyHit, type PartyState } from '@/lib/checkin/search';
import { admittedKeys, type LocalCheckIn } from '@/lib/checkin/evaluate';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from '@/components/ui/input-group';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from '@/components/ui/item';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';

/**
 * Name and ticket-code lookup (spec/ref.md §1.2, spec/tickets.md §10.1 rule 4),
 * as a list of parties (spec/v3.md §32.2).
 *
 * **Not optional.** At a real door several people per hundred cannot present a
 * scannable code — a cracked screen, a ticket printed too small, a dead phone —
 * and without this tab the queue stops. It runs against the same offline
 * manifest the camera does, so it is the way in that survives having neither a
 * camera nor a network.
 *
 * One result per party, with how many of it are in, because a family of four
 * used to come back as four unrelated rows. "Not in" is the default: an usher
 * looking someone up nearly always wants the ones still outside.
 */
export function SearchTab({
  index,
  checkIns,
  active,
  resetSignal,
  onSelect,
  onWalkIn,
}: {
  index: ManifestIndex;
  checkIns: readonly LocalCheckIn[];
  /** The tab is on screen: focus the box so the usher can type at once. */
  active: boolean;
  /** Changes after an admission from here: the query clears for the next guest. */
  resetSignal: number;
  onSelect: (entry: ManifestEntry) => void;
  /** Offered on "no match" when the concert records walk-ins. */
  onWalkIn?: (label: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState<'not-in' | 'all'>('not-in');
  const inputRef = useRef<HTMLInputElement>(null);

  const inKeys = useMemo(() => admittedKeys(index, checkIns), [index, checkIns]);
  const result = useMemo(
    () => searchParties(index, query, { admittedKeys: inKeys, notInOnly: scope === 'not-in' }),
    [index, query, inKeys, scope],
  );

  // After an admission: clear, and be ready for the next guest.
  const [lastReset, setLastReset] = useState(resetSignal);
  if (lastReset !== resetSignal) {
    setLastReset(resetSignal);
    setQuery('');
  }
  useEffect(() => {
    if (active) inputRef.current?.focus();
  }, [active, resetSignal]);

  const trimmed = query.trim();
  const shown = result.parties.length;

  return (
    <div className="flex h-full flex-col gap-3 p-4">
      <InputGroup className="h-12">
        <InputGroupInput
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            // One party: Enter opens it, so a typed code is two keystrokes.
            if (e.key === 'Enter' && result.parties.length === 1) {
              onSelect(result.parties[0].matched);
            }
          }}
          type="search"
          inputMode="search"
          placeholder="Name or ticket code"
          // A door is not the place for the OS to second-guess a surname or a
          // Crockford code. All four are needed: iOS ignores some in isolation.
          autoCapitalize="off"
          autoCorrect="off"
          autoComplete="off"
          spellCheck={false}
          enterKeyHint="search"
          aria-label="Search by name or ticket code"
          // `type="search"` brings the browser's own clear button; this box
          // already has a 44px one.
          className="text-base [&::-webkit-search-cancel-button]:appearance-none"
        />
        <InputGroupAddon>
          <Search className="size-4" />
        </InputGroupAddon>
        {query.length > 0 && (
          <InputGroupAddon align="inline-end">
            <InputGroupButton
              size="icon-sm"
              aria-label="Clear"
              onClick={() => {
                setQuery('');
                inputRef.current?.focus();
              }}
            >
              <X />
            </InputGroupButton>
          </InputGroupAddon>
        )}
      </InputGroup>

      <div className="flex items-center justify-between gap-3">
        <ToggleGroup
          value={[scope]}
          onValueChange={(value) => {
            const next = (value as string[])[0];
            if (next === 'not-in' || next === 'all') setScope(next);
          }}
          variant="outline"
          aria-label="Which parties to show"
        >
          <ToggleGroupItem value="not-in" className="h-11 px-4">
            Not in
          </ToggleGroupItem>
          <ToggleGroupItem value="all" className="h-11 px-4">
            All
          </ToggleGroupItem>
        </ToggleGroup>
        <p className="text-muted-foreground text-right text-sm" aria-live="polite">
          {trimmed.length === 0
            ? null
            : result.tooShort
              ? 'Keep typing…'
              : shown < result.total
                ? `${shown} of ${result.total} — keep typing`
                : `${result.total} ${result.total === 1 ? 'party' : 'parties'}`}
        </p>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {trimmed.length === 0 ? (
          <Empty className="h-full">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Search />
              </EmptyMedia>
              <EmptyTitle>Search the roster</EmptyTitle>
              <EmptyDescription>
                A name or the code on the ticket. Works with no camera and no signal.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : result.tooShort ? null : shown === 0 ? (
          <Empty className="h-full">
            <EmptyHeader>
              <EmptyTitle>Nobody {scope === 'not-in' ? 'still outside ' : ''}matches “{trimmed}”</EmptyTitle>
              <EmptyDescription>
                {scope === 'not-in'
                  ? 'They may already be in — try All. Or try the surname, or the code after ORC-.'
                  : 'Try the surname, or the code after ORC-. If they are sure they registered, send them to the desk.'}
              </EmptyDescription>
            </EmptyHeader>
            {onWalkIn && (
              <EmptyContent>
                <Button
                  variant="secondary"
                  size="lg"
                  className="h-12"
                  onClick={() => onWalkIn(trimmed)}
                >
                  <UserPlus />
                  Record as walk-in
                </Button>
              </EmptyContent>
            )}
          </Empty>
        ) : (
          <ItemGroup className="gap-2">
            {result.parties.map((party) => (
              <PartyResult key={party.registrationId} party={party} onSelect={onSelect} />
            ))}
          </ItemGroup>
        )}
      </div>
    </div>
  );
}

/** Status by shape as well as colour (§32.2): the usher may not see the colour. */
const STATE: Record<PartyState, { icon: React.ReactNode; badge: (p: PartyHit) => React.ReactNode }> = {
  NOT_IN: {
    icon: <CircleDashed />,
    badge: (p) => (p.size > 1 ? <Badge variant="outline">0 of {p.size} in</Badge> : <Badge variant="outline">Not in</Badge>),
  },
  PARTLY_IN: {
    icon: <CircleDot />,
    badge: (p) => (
      <Badge variant="secondary">
        {p.admitted} of {p.size} in
      </Badge>
    ),
  },
  ALL_IN: {
    icon: <CircleCheck />,
    badge: () => <Badge variant="secondary">All in</Badge>,
  },
  CANCELLED: {
    icon: <CircleSlash />,
    badge: () => <Badge variant="destructive">Cancelled</Badge>,
  },
  NO_TICKET: {
    icon: <TicketX />,
    badge: () => <Badge variant="outline">No ticket</Badge>,
  },
};

function PartyResult({
  party,
  onSelect,
}: {
  party: PartyHit;
  onSelect: (entry: ManifestEntry) => void;
}) {
  const { matched } = party;
  const state = STATE[party.state];
  const matchedName = matched.nameSource === 'PLACEHOLDER' ? null : matched.name;
  return (
    <Item
      variant="outline"
      // 64px of target: tapped one-handed, at speed, by someone holding programmes.
      className="min-h-16"
      render={<button type="button" onClick={() => onSelect(matched)} />}
    >
      <ItemMedia variant="icon">{state.icon}</ItemMedia>
      <ItemContent>
        <ItemTitle className="text-base">
          {matchedName && matchedName !== party.label ? (
            <>
              <Highlighted name={matchedName} range={party.highlight} />
              <span className="text-muted-foreground font-normal"> · {party.label}&rsquo;s party</span>
            </>
          ) : (
            <Highlighted name={party.label} range={matchedName ? party.highlight : null} />
          )}
        </ItemTitle>
        <ItemDescription>
          {party.size > 1 ? `Party of ${party.size}` : 'One seat'}
          {party.matchedOn !== 'name' && matched.ticketCode ? (
            <span className="font-mono"> · {matched.ticketCode}</span>
          ) : null}
          {matched.playerName ? ` · Guest of ${matched.playerName}` : ''}
        </ItemDescription>
      </ItemContent>
      <ItemActions>{state.badge(party)}</ItemActions>
    </Item>
  );
}

function Highlighted({
  name,
  range,
}: {
  name: string;
  range: { start: number; end: number } | null;
}) {
  if (!range) return <>{name}</>;
  return (
    <>
      {name.slice(0, range.start)}
      <mark className="bg-primary/25 text-foreground rounded-sm">{name.slice(range.start, range.end)}</mark>
      {name.slice(range.end)}
    </>
  );
}
