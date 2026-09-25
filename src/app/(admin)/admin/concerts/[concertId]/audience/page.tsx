import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { parseTableState } from '@/components/data-table/url-state';
import { requireRole } from '@/lib/auth/guards';
import { maskForRole, masksContacts } from '@/lib/auth/mask';
import {
  AUDIENCE_URL_KEYS,
  filterFromUrl,
  findView,
  grainFromUrl,
  partyFilter,
} from '@/lib/audience/filter';
import {
  audienceOptions,
  listParties,
  listSeats,
  poolMeters,
  viewCounts,
} from '@/lib/audience/queries';
import { getConcertHeader } from '../shows/queries';
import { listPlayerOptions, listSegmentOptions } from '../registrations/queries';
import { AudienceTable } from './audience-table';
import { CommandHost } from './command-host';
import { NewParty } from './new-party';
import { PoolMeters } from './pool-meter';

export const metadata: Metadata = { title: 'Audience' };

/**
 * `/admin/concerts/{id}/audience` — the Audience workspace (spec/v3.md §22).
 *
 * One table over `party_pipeline`, at the grain of parties or seats, with a
 * built-in view per stage and per flag. It replaces the Registrations,
 * Unverified, Extras review and Tickets screens; their work is now views,
 * commands and the party record.
 */
export default async function AudiencePage({
  params,
  searchParams,
}: {
  params: Promise<{ concertId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireRole('ADMIN', 'VIEWER');
  const read = { searchContacts: !masksContacts(user.role) };
  const { concertId: raw } = await params;
  const concertId = Number(raw);
  if (!Number.isInteger(concertId) || concertId <= 0) notFound();

  const concert = await getConcertHeader(concertId);
  if (!concert) notFound();
  const timeZone = concert.timezone ?? 'UTC';

  const state = parseTableState(await searchParams, { extraKeys: AUDIENCE_URL_KEYS });
  // A hand-edited `?view=` that names no view is dropped, so the page shows
  // All and says so, rather than listing everything under an unknown name.
  if (state.extra.view && !findView(state.extra.view)) delete state.extra.view;
  const grain = grainFromUrl(state.extra);
  const filter = filterFromUrl(state.extra, state.search);
  const paging = { pageIndex: state.pageIndex, pageSize: state.pageSize, sorting: state.sorting };

  const [page, counts, options, meters, segments, players] = await Promise.all([
    grain === 'seats'
      ? listSeats(concertId, filter, paging, read)
      : listParties(concertId, filter, paging, read),
    viewCounts(concertId, partyFilter(filter), read),
    audienceOptions(concertId),
    filter.view === 'needs-review'
      ? poolMeters(concertId, { segmentId: filter.segmentId, showId: filter.showId })
      : Promise.resolve([]),
    listSegmentOptions(concertId),
    listPlayerOptions(concertId),
  ]);

  return (
    <CommandHost concertId={concertId} data={{ segments: options.segments, players: options.players }}>
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold">Audience</h1>
            <p className="text-muted-foreground text-sm">
              Every party and seat, with where each one is and what it needs next. Open a party
              for its record.
            </p>
          </div>
          <NewParty
            concertId={concertId}
            timeZone={concert.timezone}
            segments={segments}
            players={players}
          />
        </div>
        <AudienceTable
          concertId={concertId}
          timeZone={timeZone}
          grain={grain}
          filter={filter}
          state={state}
          // Masked on the server for a viewer (§28): a mask in the browser would be
          // over data the RSC payload already carried.
          page={maskForRole(user.role, page)}
          counts={counts}
          options={options}
          toolbarExtra={meters.length > 0 ? <PoolMeters meters={meters} /> : undefined}
        />
      </div>
    </CommandHost>
  );
}
