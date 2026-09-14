import type { Metadata } from 'next';
import { ClockAlertIcon, TicketCheckIcon } from 'lucide-react';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { loadEditableResponse } from '@/lib/registrations/edit';
import { FormNotFound } from '../states';
import { EditResponseForm } from './edit-form';

/**
 * `/f/{slug}/edit?r={edit_token}` — changing a response (spec/v2.md §8.3.1).
 *
 * The token is the credential, exactly as it is on the player form and the
 * ticket page: possession of the link from the confirmation email is what
 * authorises the change, and there is no account to log into.
 *
 * **The screen offers no way to add a guest.** That is the rule the whole
 * section exists for — an edit form that can claim inventory is a second,
 * unpoliced allocation path — so the absence is structural rather than a
 * disabled button, and the server refuses an unknown attendee id regardless.
 * What it offers instead is "request extra tickets", which is a new request at
 * the back of the queue.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Change your registration',
  robots: { index: false, follow: false },
};

export default async function EditResponsePage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ r?: string | string[] }>;
}) {
  await params;
  const query = await searchParams;
  const token = typeof query.r === 'string' ? query.r : null;
  if (token === null) return <FormNotFound />;

  const response = await loadEditableResponse(token);
  if (!response) return <FormNotFound />;

  /**
   * Closed, with the reason — the two are different facts for the reader and
   * have different remedies. "Too late" is final; "your tickets are out" is a
   * redirect to a person who can still help.
   */
  if (response.closedReason === 'TICKETS_SENT') {
    return (
      <Empty className="border-0">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <TicketCheckIcon />
          </EmptyMedia>
          <EmptyTitle>Your tickets have already been sent</EmptyTitle>
          <EmptyDescription>
            Changes now need to go through the orchestra, because a name change on a ticket already
            in your inbox needs to be re-issued rather than quietly differ. Please get in touch and
            we will sort it out.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  if (response.closedReason === 'WINDOW') {
    return (
      <Empty className="border-0">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <ClockAlertIcon />
          </EmptyMedia>
          <EmptyTitle>Changes have closed</EmptyTitle>
          <EmptyDescription>
            The window for changing this registration has passed. If something is wrong, please
            contact the orchestra — your seats are unaffected.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-3">
        <h1 className="text-2xl font-semibold tracking-tight text-balance">
          Change your registration
        </h1>
        <p className="text-sm text-muted-foreground">
          You can correct names and contact details, or release a seat you no longer need. Released
          seats go back to the pool straight away.
        </p>
      </header>

      <EditResponseForm editToken={token} response={response} />
    </div>
  );
}
