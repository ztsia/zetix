import type { Metadata } from 'next';
import { ClockAlertIcon } from 'lucide-react';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { loadUpdatableParty } from '@/lib/intake/party-update';
import { formatDateTime } from '@/lib/portal/format';
import { FormNotFound } from '../[slug]/states';
import { UpdateParty } from './update-party';

/**
 * `/f/update?t={token}` — the party update link (spec/v3.md §25.6).
 *
 * The link comes in the party's receipt and only there: possession of it is
 * the credential, and it lets the party name its guests, correct its address,
 * or give back seats — never add one.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Your registration',
  robots: { index: false, follow: false },
};

export default async function UpdatePartyPage({
  searchParams,
}: {
  searchParams: Promise<{ t?: string | string[] }>;
}) {
  const query = await searchParams;
  const token = typeof query.t === 'string' ? query.t : null;
  if (token === null) return <FormNotFound />;

  const party = await loadUpdatableParty(token);
  // One answer for every miss (§13.2's rule).
  if (!party) return <FormNotFound />;

  const when = formatDateTime(party.startsAt ? new Date(party.startsAt) : null, party.timeZone);

  if (party.closedReason === 'SHOW_STARTED') {
    return (
      <Empty className="bg-form-card rounded-lg border border-solid border-form-line">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <ClockAlertIcon />
          </EmptyMedia>
          <EmptyTitle>The concert has started</EmptyTitle>
          <EmptyDescription>
            Your registration can no longer be changed here. Please speak to the organisers.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return <UpdateParty token={token} party={party} when={when} />;
}
