import type { Metadata } from 'next';
import { CircleCheckIcon, MailCheckIcon } from 'lucide-react';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { verifyRegistration } from '@/lib/registrations/verification';
import { FormNotFound } from '../[slug]/states';

/**
 * `/f/verify?t={token}` — the double opt-in landing page (spec/v2.md §8.1.4).
 *
 * **Nothing about a seat happens here.** The registration was `CONFIRMED` at
 * submit, because seats are scarce and holding them for an unclicked link gives
 * them away. All this page does is record that somebody reads the address, which
 * releases the party into the ticket blast's eligible set.
 *
 * That is worth saying *on the page*: a registrant who has been waiting to be
 * told whether they got in should not read "verified" and wonder whether the
 * seats were conditional on it.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Confirm your email',
  robots: { index: false, follow: false },
};

export default async function VerifyPage({
  searchParams,
}: {
  searchParams: Promise<{ t?: string | string[] }>;
}) {
  const query = await searchParams;
  const token = typeof query.t === 'string' ? query.t : null;
  if (token === null) return <FormNotFound />;

  const outcome = await verifyRegistration(token);

  /**
   * An unknown token gets the *same* response as an unknown form — one answer
   * for "no such token", "malformed" and "the registration is gone", following
   * the ticket page's rule (§13.2). A link that has been forwarded around is a
   * guessable thing, and distinguishing the failures tells a prober which
   * guesses are worth more.
   */
  if (outcome.state === 'UNKNOWN') return <FormNotFound />;

  return (
    <Empty className="border-0">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          {outcome.state === 'VERIFIED' ? <CircleCheckIcon /> : <MailCheckIcon />}
        </EmptyMedia>
        <EmptyTitle>
          {outcome.state === 'VERIFIED'
            ? 'Thank you — your email is confirmed'
            : 'Your email was already confirmed'}
        </EmptyTitle>
        <EmptyDescription>
          {/*
            The seats were never at stake, and the page says so. Somebody who has
            been waiting to hear whether they got in must not read this and
            conclude their place depended on clicking a link they nearly missed.
          */}
          Your seats were confirmed when you registered, {outcome.contactName} — confirming your
          address only tells us we can reach you. Your tickets will arrive by email before the
          concert.
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}
