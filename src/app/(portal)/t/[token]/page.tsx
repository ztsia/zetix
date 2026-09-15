import type { ReactNode } from 'react';
import type { Metadata } from 'next';
import { CalendarDaysIcon, DoorOpenIcon, MapPinIcon, TriangleAlertIcon } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Item, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemTitle } from '@/components/ui/item';
import { BookletSection } from '@/components/portal/booklet-section';
import { FeedbackClosed, FeedbackSection } from '@/components/portal/feedback-section';
import { PracticalSection } from '@/components/portal/practical-section';
import { TicketSection, TicketStub } from '@/components/portal/ticket-section';
import { countdownTo, formatDate, formatDateTime, formatTime, venueMapUrl } from '@/lib/portal/format';
import { publishedBookletForShow } from '@/lib/portal/booklet';
import { loadPortalFeedback, type PortalFeedbackResult } from '@/lib/portal/feedback';
import { qrSvg } from '@/lib/portal/qr';
import {
  portalIsUnlocked,
  sectionOrder,
  type PortalSectionId,
} from '@/lib/portal/sections';
import { attendeeIdForToken, ticketStatus } from '@/lib/portal/status';
import type { FormAnswers } from '@/lib/forms/answers';
import { submitFeedbackAction } from './feedback-actions';
import { TicketNotFound } from '../../ticket-not-found';
import { Countdown } from './countdown';

/**
 * `/t/{qr_token}` — the read-only ticket status page (spec/README.md §4.1).
 *
 * **This page exists so that scanning your own QR is never a 404.** The URL is
 * printed on something we told someone is their ticket, and a ticket holder
 * checking it three days early out of curiosity must get something friendly
 * (spec/v2.md §13.2). That is the whole brief.
 *
 * **V2 grows it into the full portal** (§13.3) without disturbing that brief.
 * The rows of §13.2's table are still served to every real ticket, whatever else
 * is or is not configured; the sections are what `portal.unlock_mode` and the
 * per-section flags add on top.
 *
 * Three rules govern what appears, and each is easy to get backwards:
 *
 * - **`portal.unlock_mode` answers who, never when** (decision 39). It gates who
 *   may see the unlocked sections and is never flipped by a show reaching
 *   `COMPLETED`. Resolved through the cascade, never off
 *   `shows.portal_unlock_mode` (§2.2) — a null column means the show does not
 *   override, not `ON_ADMISSION`.
 * - **`concerts.portal_enabled` does not gate the status page** (§13.2). A
 *   printed QR cannot be recalled when a flag is flipped, so turning the portal
 *   off must never turn a ticket into a dead link. It governs the sections
 *   below, and nothing above them.
 * - **"The show is over" comes off the clock, not off `shows.status`**
 *   (decision 40). The flag trails by up to a day; the phase is correct the
 *   instant it is true.
 *
 * **The section list is a slot, and `O` mounts notes and the wall into it.**
 * `lib/portal/sections.ts` owns which sections exist and in what order; this
 * file owns what each one looks like. The slot takes an ordering rather than an
 * append because feedback is last in §13.3's list and first on the page once the
 * show is over.
 *
 * **Nothing about admission depends on any of this** (decision 28). The door
 * scanner matches the token against its offline manifest and never dereferences
 * the QR, so this page being slow, wrong or entirely down cannot keep a guest
 * out (spec/tickets.md §10.1 rule 1).
 */

/**
 * Never cached. Admission and cancellation both change what this says, and a
 * cached "not yet admitted" would be merely stale while a cached "valid ticket"
 * for a cancelled party is the page contradicting the front desk.
 */
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Your ticket',
  /** Restated at every level that matters — the token is the credential (§13.3). */
  robots: { index: false, follow: false },
};

export default async function TicketStatusPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const status = await ticketStatus(token);

  /**
   * One response for "no such ticket", "malformed token" and "soft-deleted".
   * A ticket holder cannot act on the difference, and anyone probing tokens
   * must not learn it — the three render byte-identical pages.
   *
   * **Rendered, not thrown, and that costs the 404 status deliberately.**
   * `notFound()` inside a dynamic Server Component discards the shell: Next
   * puts the boundary's content behind a Suspense swap, so the server sends an
   * empty `<body>` and the friendly copy only arrives once client JavaScript
   * runs. Measured on this page in a production build on Regular 3G, that was
   * roughly **5.2s of blank white** — the wait for the full bundle — against a
   * ~0.45s server paint, and **nothing at all** with JavaScript off. (An
   * earlier draft of this comment said 6.5s, from a measurement that compared
   * a cold load against a warm one. The JavaScript-off case is what set the
   * severity, and it was never a matter of degree.) Every route this branch
   * tried keeps that behaviour: co-locating a `not-found.tsx` at this segment
   * does not change it, and dropping `force-dynamic` costs the happy path its
   * server render too.
   *
   * So the choice is a correct status code with a blank page, or the page with
   * a 200.
   *
   * **The spec does not decide this, and it is worth being honest about that.**
   * §13.2's table covers Issued, Admitted and Cancelled — three states of a
   * real ticket — and "must get something friendly, not a 404" is about a
   * holder scanning *their own* QR early, not about a token that resolves to
   * nothing. An independent QA pass made exactly that objection to an earlier
   * version of this comment, which quoted those sentences as though they
   * settled it. §13.2 now carries a fourth row so the next reader is not left
   * to infer one.
   *
   * The call is made on the merits instead. The people who land here are
   * holding a superseded ticket or a clipped QR, outside a hall, on venue wifi;
   * the blank screen is the failure this module was written to prevent, and it
   * is measured. The cost is abstract by comparison — see below.
   *
   * What the status is *not* carrying: it never distinguished a real ticket
   * from a missing one to anyone who did not already have the token, because
   * the body always did that. Unknown and malformed tokens stay
   * indistinguishable from each other, which is the property that matters. And
   * nothing machine-readable reads this surface — it is `noindex`, has no API
   * clients, and admission never touches it (decision 28).
   *
   * **What it does cost, so nobody rediscovers it at 8pm on the night:** an
   * uptime check pointed at a ticket URL will report healthy after that ticket
   * is deleted, and a surge of dead-token traffic no longer shows up in
   * anything that counts non-2xx responses. If that signal is ever wanted, the
   * answer is a counter on this branch, not a status code that blanks the page.
   */
  if (!status) return <TicketNotFound />;

  const { show, timeZone } = status;
  const cancelled = status.state === 'CANCELLED';
  const admitted = status.state === 'ADMITTED';

  /**
   * **Who, not when** (decision 39). `portal.enabled` is a separate question
   * asked separately below: one says whether this guest may see the sections,
   * the other whether this concert runs them at all.
   */
  const unlocked = portalIsUnlocked({
    mode: status.portal.unlockMode,
    admitted,
    cancelled,
  });
  const sectionsVisible = unlocked && status.portal.enabled;

  /**
   * The post-show layout applies only to someone who can actually see the
   * sections. A holder still looking at a locked status page has nothing to
   * reorder, and collapsing their ticket to a stub would take the QR away from
   * the one person on this page who might still be about to use it — a guest
   * whose show ran late, or whose `ends_at` is simply wrong.
   */
  const postShow = status.showIsOver && sectionsVisible;

  const showDate = formatDate(show.startsAt, timeZone);
  const showTime = formatTime(show.startsAt, timeZone);
  const doorsTime = formatTime(show.doorsOpenAt, timeZone);
  const mapUrl = venueMapUrl(show.venueName, show.venueAddress);
  const admittedAt = admitted ? formatDateTime(status.admittedAt, timeZone) : null;
  const ticketHref = `/api/portal/${status.qrToken}/ticket`;

  /**
   * Looked up only when the section could actually be drawn. A concert with the
   * portal off, or a guest who has not unlocked it, should not cost a query for
   * a booklet nobody is going to be shown.
   */
  const booklet =
    sectionsVisible && status.portal.bookletEnabled
      ? await publishedBookletForShow({ showId: show.id, concertId: status.concertId })
      : null;

  /**
   * **Loaded only once the evening is over**, because §13.2's second row is
   * explicit that an admitted guest whose show is still running gets no feedback
   * form: the question has no answer yet. `portal.feedback_enabled` is the
   * separate question of whether this show runs one at all.
   *
   * The attendee id is resolved here rather than carried on the page payload —
   * it is needed to find this guest's own existing answer and nothing renders
   * it.
   */
  const attendeeId =
    postShow && status.portal.feedbackEnabled ? await attendeeIdForToken(token) : null;
  const feedback =
    attendeeId === null
      ? null
      : await loadPortalFeedback({
          showId: show.id,
          concertId: status.concertId,
          attendeeId,
          closeAt: status.portal.feedbackCloseAt,
        });

  /**
   * Counted to the doors, not to the downbeat — the doors time is the one a
   * guest acts on. Falls back to the start time when no doors time is set, and
   * disappears entirely when neither is: half the show columns are nullable and
   * an unconfigured concert must still render a scannable ticket.
   *
   * **Gone once the show is over**, because a countdown that has run out reads
   * "Doors are open" for ever, and a page telling last night's audience the
   * doors are open is worse than one telling them nothing.
   */
  const countdownTarget = show.doorsOpenAt ?? show.startsAt;
  const countdown = cancelled || status.showIsOver ? null : countdownTo(countdownTarget, new Date());

  /**
   * What each slot draws, or `null` for a section this show does not run.
   *
   * **`notes` and `wall` are `O`'s** (§13.4). They are named here, rendering
   * nothing, so that `O` supplies two nodes and changes no ordering, no unlock
   * rule and no layout — the seam agreed in this branch's handoff.
   *
   * Each section carries its own lifecycle and they are deliberately
   * independent: `booklets.published` and `portal.notes_close_at` end their own
   * sections, which is why `COMPLETED` never needed to close the portal
   * (decision 39).
   */
  const sections: Record<PortalSectionId, ReactNode> = {
    ticket: postShow ? (
      <TicketStub
        key="ticket"
        name={status.attendeeName}
        admitted={admitted}
        admittedAt={admittedAt}
        downloadHref={ticketHref}
      />
    ) : (
      <TicketSection
        key="ticket"
        name={status.attendeeName}
        ticketCode={status.ticketCode}
        qr={await qrSvg(status.qrToken)}
        admitted={admitted}
        admittedAt={admittedAt}
        downloadHref={ticketHref}
      />
    ),
    booklet: booklet ? (
      <BookletSection
        key="booklet"
        title={booklet.title}
        href={`/api/portal/${status.qrToken}/booklet`}
      />
    ) : null,
    notes: null,
    wall: null,
    practical:
      sectionsVisible && status.portal.practicalInfoMd ? (
        <PracticalSection key="practical" markdown={status.portal.practicalInfoMd} />
      ) : null,
    feedback: feedbackNode(token, feedback),
  };

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col gap-5 px-4 py-8">
      <header className="space-y-1 text-center">
        <p className="text-sm text-muted-foreground">{status.concertName}</p>
        <h1 className="text-2xl font-semibold tracking-tight text-balance">{show.name}</h1>
      </header>

      {cancelled ? (
        <Alert variant="destructive">
          <TriangleAlertIcon />
          <AlertTitle>This ticket is no longer valid</AlertTitle>
          <AlertDescription>
            Please see the front desk. They can look up your booking and help.
          </AlertDescription>
        </Alert>
      ) : (
        /**
         * The ordered slot. Before the show this leads with the ticket; after
         * it, feedback comes first and the ticket collapses to a stub at the
         * end (§13.2, §13.3).
         */
        sectionOrder(postShow).map((id) => sections[id])
      )}

      {countdown && countdownTarget ? (
        <p className="text-center text-sm text-muted-foreground" aria-live="off">
          {countdown.open ? (
            <Countdown
              targetIso={countdownTarget.toISOString()}
              initialLabel={DOORS_OPEN}
              openLabel={DOORS_OPEN}
            />
          ) : (
            <>
              {'Doors open '}
              <Countdown
                targetIso={countdownTarget.toISOString()}
                initialLabel={`in ${countdown.label}`}
                openLabel={DOORS_OPEN}
              />
            </>
          )}
        </p>
      ) : null}

      <ItemGroup className="gap-2">
        {showDate ? (
          <Item variant="muted">
            <ItemMedia variant="icon">
              <CalendarDaysIcon />
            </ItemMedia>
            <ItemContent>
              <ItemTitle className="text-base">{showDate}</ItemTitle>
              {showTime ? <ItemDescription>Starts {showTime}</ItemDescription> : null}
            </ItemContent>
          </Item>
        ) : null}

        {doorsTime ? (
          <Item variant="muted">
            <ItemMedia variant="icon">
              <DoorOpenIcon />
            </ItemMedia>
            <ItemContent>
              <ItemTitle className="text-base">Doors open {doorsTime}</ItemTitle>
              <ItemDescription>Free seating — sit anywhere you like.</ItemDescription>
            </ItemContent>
          </Item>
        ) : null}

        {show.venueName || show.venueAddress ? (
          /**
           * The whole row is the link when there is somewhere to point at, so
           * the tap target is the full width of the card rather than a few
           * words of address — this is read one-handed, outdoors, possibly in
           * the rain.
           */
          <Item
            variant="muted"
            render={
              mapUrl ? <a href={mapUrl} target="_blank" rel="noreferrer noopener" /> : undefined
            }
          >
            <ItemMedia variant="icon">
              <MapPinIcon />
            </ItemMedia>
            <ItemContent>
              <ItemTitle className="text-base">{show.venueName ?? 'Venue'}</ItemTitle>
              {show.venueAddress ? (
                <ItemDescription className="whitespace-pre-line">
                  {show.venueAddress}
                </ItemDescription>
              ) : null}
            </ItemContent>
          </Item>
        ) : null}
      </ItemGroup>
    </main>
  );
}

const DOORS_OPEN = 'Doors are open';

/**
 * The feedback slot's three outcomes, kept out of the section map so each one is
 * readable.
 *
 * - **Nothing at all** — this show runs no feedback form, or the phase has not
 *   arrived. An absent section, not an empty one.
 * - **Closed** — `portal.feedback_close_at` has passed. Still rendered: the
 *   guest followed a link from an email we sent them, and silence where the form
 *   was is not an answer.
 * - **The form**, prefilled with their own previous answer when they have left
 *   one.
 */
function feedbackNode(token: string, feedback: PortalFeedbackResult | null): ReactNode {
  if (feedback === null) return null;

  if ('state' in feedback) {
    return feedback.state === 'CLOSED' ? <FeedbackClosed key="feedback" /> : null;
  }

  return (
    <FeedbackSection
      key="feedback"
      token={token}
      formId={feedback.id}
      schema={feedback.schema}
      title={feedback.title}
      descriptionMd={feedback.descriptionMd}
      copy={feedback.copy}
      existing={(feedback.existing?.answers as FormAnswers | undefined) ?? null}
      submit={submitFeedbackAction}
    />
  );
}
