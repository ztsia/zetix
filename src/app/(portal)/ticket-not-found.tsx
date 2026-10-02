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
 * front desk — rather than apologising at them.
 *
 * **It promises nothing about the emailed PDF** (spec/v3.md §32.3). The likeliest
 * reasons a real guest lands here are a voided QR and a removed seat, and in
 * both the PDF they hold will not admit them. The most recent email, and the
 * desk, are what is true in every case.
 *
 * Lives in its own file because it is rendered from two places: `page.tsx`
 * returns it directly (see the note there on why it is not thrown), and
 * `not-found.tsx` is the boundary for anything else in this route group.
 */
export function TicketNotFound() {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center px-4 py-8">
      <Empty className="border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <TicketXIcon />
          </EmptyMedia>
          <EmptyTitle>We could not find that ticket</EmptyTitle>
          <EmptyDescription>
            The link may be incomplete, or the ticket may have been replaced. Open the most
            recent ticket email we sent you and use the link there. If it still doesn&rsquo;t
            work, the front desk can find you by name on the night.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    </main>
  );
}
