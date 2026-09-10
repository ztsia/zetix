import { TicketXIcon } from 'lucide-react';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';

/**
 * What a ticket holder sees when the token in the URL resolves to nothing.
 *
 * **It says the same thing for every reason it could happen** — a mistyped
 * link, a token that never existed, a soft-deleted attendee. A ticket holder
 * cannot act on the difference, and anyone working through candidate tokens
 * must not be told which guesses were closer.
 *
 * The tone matters more than it looks. This is the page reached by someone
 * standing outside a hall holding what they believe is a ticket, so it names
 * the two things that actually help — the email the ticket came from, and the
 * front desk — rather than apologising at them. The PDF in their inbox is still
 * the ticket of record (spec/v2.md §13.1) and the door can admit them from it,
 * or from their name, with this page never resolving at all (decision 28).
 */
export default function TicketNotFound() {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center px-4 py-8">
      <Empty className="border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <TicketXIcon />
          </EmptyMedia>
          <EmptyTitle>We could not find that ticket</EmptyTitle>
          <EmptyDescription>
            The link may be incomplete. Open it again from your ticket email, or show the PDF
            attached to that email at the door — it is your ticket, and it will get you in.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    </main>
  );
}
