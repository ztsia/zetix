import type { Metadata } from 'next';
import { MailWarningIcon } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { requireRole } from '@/lib/auth/guards';
import { unverifiedRegistrations } from './queries';
import { UnverifiedTable } from './unverified-table';
import { maskForRole } from '@/lib/auth/mask';

/**
 * **Registrations → Unverified** (spec/v2.md §8.1.4).
 *
 * *"Unverified registrations older than 48h are flagged for admin review"* —
 * the threshold is `form.verification_grace_hours` through the cascade.
 *
 * **In practice this is the bounce list.** Nothing in the system reads delivery
 * failures back: Gmail returns a DSN to the sending mailbox and nothing parses
 * it. So a mistyped address that survived every check at submit — and
 * `zxguest@yahoo.com.my`, a real domain with a dead mailbox, survives all of
 * them — produces exactly one visible symptom anywhere in the system, and it is
 * a row on this page.
 *
 * Which is why the screen leads with what to *do*: these people hold seats and
 * cannot be reached, and the two ways forward are to correct the address or to
 * release the party on an address the organisers trust.
 */

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Unverified registrations' };

export default async function UnverifiedPage({
  params,
}: {
  params: Promise<{ concertId: string }>;
}) {
  const user = await requireRole('ADMIN', 'VIEWER');
  const { concertId } = await params;
  const id = Number(concertId);

  const { rows, graceHours } = await unverifiedRegistrations(id);
  const overdue = rows.filter((row) => row.overdue);

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <h1 className="text-xl font-semibold tracking-tight">Unverified registrations</h1>
        <p className="text-sm text-muted-foreground">
          Public registrants who have not clicked their verification link. They hold their seats —
          verification gates the ticket email, never the seat — but their tickets are excluded from
          the blast until they verify or you release them here.
        </p>
      </header>

      {rows.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <MailWarningIcon />
            </EmptyMedia>
            <EmptyTitle>Everyone has verified</EmptyTitle>
            <EmptyDescription>
              Nothing is being held back. Imported and player registrations never appear here —
              neither was sent a link.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <>
          {overdue.length > 0 ? (
            <Alert>
              <MailWarningIcon />
              <AlertTitle>
                {overdue.length} registration{overdue.length === 1 ? ' has' : 's have'} been waiting
                over {graceHours} hours
              </AlertTitle>
              <AlertDescription>
                An address that never verifies is usually an address that never arrived. Check the
                spelling with the registrant where you can, and release the party once you are
                confident it will reach them.
              </AlertDescription>
            </Alert>
          ) : null}

          <UnverifiedTable concertId={id} rows={maskForRole(user.role, rows)} />
        </>
      )}
    </div>
  );
}
