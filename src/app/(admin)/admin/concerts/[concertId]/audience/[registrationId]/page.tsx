import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { requireRole } from '@/lib/auth/guards';
import { maskForRole, masksContacts } from '@/lib/auth/mask';
import { audienceOptions } from '@/lib/audience/queries';
import { loadPartyRecord, type PartyRecord as PartyRecordData } from '@/lib/audience/record';
import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from '@/components/ui/empty';
import { getConcertHeader } from '../../shows/queries';
import { listPlayerOptions, listSegmentOptions } from '../../registrations/queries';
import { CommandHost } from '../command-host';
import { PartyRecord } from './party-record';

export const metadata: Metadata = { title: 'Party' };

/**
 * `/admin/concerts/{id}/audience/{registrationId}` — the party record
 * (spec/v3.md §22.4): every step for one party, and every action on it.
 */
export default async function PartyRecordPage({
  params,
}: {
  params: Promise<{ concertId: string; registrationId: string }>;
}) {
  const user = await requireRole('ADMIN', 'VIEWER');
  const { concertId: rawConcert, registrationId: rawParty } = await params;
  const concertId = Number(rawConcert);
  const registrationId = Number(rawParty);
  if (!Number.isSafeInteger(concertId) || concertId <= 0) notFound();
  if (!Number.isSafeInteger(registrationId) || registrationId <= 0) notFound();

  const concert = await getConcertHeader(concertId);
  if (!concert) notFound();

  const record = await loadPartyRecord(concertId, registrationId);
  if (!record) {
    // A party deleted since the link was made is in the Trash, not gone; say so
    // rather than 404ing a link someone followed from the Activity log.
    const [trashed] = await getDb().execute<{ merged_into_id: string | null }>(sql`
      select r.merged_into_id from registrations r join shows s on s.id = r.show_id
       where r.id = ${registrationId} and s.concert_id = ${concertId} and r.deleted_at is not null
    `);
    if (!trashed) notFound();
    return (
      <Empty className="border-border min-h-[50vh] rounded-lg border border-dashed">
        <EmptyHeader>
          <EmptyTitle>This party was deleted</EmptyTitle>
          <EmptyDescription>
            {trashed.merged_into_id
              ? 'It was merged into another party.'
              : 'It is in the Trash, where it can be restored.'}
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button
            variant="outline"
            nativeButton={false}
            render={
              <Link
                href={
                  trashed.merged_into_id
                    ? `/admin/concerts/${concertId}/audience/${trashed.merged_into_id}`
                    : `/admin/concerts/${concertId}/trash`
                }
              />
            }
          >
            {trashed.merged_into_id ? 'Open the party it joined' : 'Open the Trash'}
          </Button>
        </EmptyContent>
      </Empty>
    );
  }

  const [options, segments, players] = await Promise.all([
    audienceOptions(concertId),
    listSegmentOptions(concertId),
    listPlayerOptions(concertId),
  ]);

  return (
    <CommandHost concertId={concertId} data={{ segments: options.segments, players: options.players }}>
      <PartyRecord
        concertId={concertId}
        timeZone={concert.timezone ?? 'UTC'}
        record={maskForRole(user.role, forViewer(record, masksContacts(user.role)))}
        segments={segments}
        players={players}
      />
    </CommandHost>
  );
}

/**
 * What a viewer's record leaves out before the mask (spec/v3.md §28).
 *
 * The mask finds addresses anywhere and phones under phone-named keys, but a
 * form response is keyed by the form's block ids, so a phone answer there is
 * under a key the mask cannot read as a phone. The raw answers and the kept
 * custom answers are withheld from a viewer instead; the record says so.
 */
function forViewer(record: PartyRecordData, viewer: boolean): PartyRecordData {
  if (!viewer) return record;
  return {
    ...record,
    responses: record.responses.map((response) => ({ ...response, raw: null })),
    import: record.import
      ? { ...record.import, rows: record.import.rows.map((row) => ({ ...row, raw: null })) }
      : null,
    custom: null,
  };
}
