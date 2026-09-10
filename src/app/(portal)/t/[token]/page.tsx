import type { Metadata } from 'next';
import { CalendarDaysIcon, CircleCheckIcon, DoorOpenIcon, MapPinIcon, TriangleAlertIcon } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Item, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemTitle } from '@/components/ui/item';
import { countdownTo, formatDate, formatDateTime, formatTime, venueMapUrl } from '@/lib/portal/format';
import { qrSvg } from '@/lib/portal/qr';
import { ticketStatus } from '@/lib/portal/status';
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
 * It is the V1 subset of §13.2's progressive disclosure, and it stops there:
 * the booklet, notes and the public wall unlock on admission in **V2**
 * (spec/v2.md §13.3). An admitted holder here gets the same page with a
 * checked-in badge — honest about what the system knows, and nothing built
 * toward a surface V1 does not ship.
 *
 * **`shows.portal_unlock_mode` is not read, and that is not an oversight.** Its
 * three values distinguish what the *unlocked* portal reveals (§13.2); with no
 * booklet and no notes in V1 there is nothing behind the lock, so `ON_ADMISSION`,
 * `OPEN_TO_ALL` and `CLOSED` would all render this identical page. Resolving a
 * setting to ignore its answer would read as support for a feature that does not
 * exist. V2 is where that cascade lookup belongs.
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
   * runs. Measured on this page in a production build, that is 6.5s of blank
   * white on Regular 3G, and nothing at all with JavaScript off — while the
   * same request for a *valid* token paints in 562ms. Every route this branch
   * tried keeps that behaviour: co-locating a `not-found.tsx` at this segment
   * does not change it, and dropping `force-dynamic` costs the happy path its
   * server render too.
   *
   * So the choice is a correct status code with a blank page, or the page with
   * a 200. The spec picks for us, twice and literally: this page exists because
   * "a 404 there is a support call on concert night" (spec/README.md §4.1), and
   * a curious ticket holder "must get something friendly, not a 404"
   * (spec/v2.md §13.2). The people who land here are holding a superseded
   * ticket or a clipped QR, outside a hall, on venue wifi — the blank screen is
   * the failure this module was written to prevent.
   *
   * What the status is *not* carrying: it never distinguished a real ticket
   * from a missing one to anyone who did not already have the token, because
   * the body always did that. Unknown and malformed tokens stay
   * indistinguishable from each other, which is the property that matters. And
   * nothing machine-readable reads this surface — it is `noindex`, has no API
   * clients, and admission never touches it (decision 28).
   */
  if (!status) return <TicketNotFound />;

  const { show, timeZone } = status;
  const cancelled = status.state === 'CANCELLED';
  const admitted = status.state === 'ADMITTED';

  const showDate = formatDate(show.startsAt, timeZone);
  const showTime = formatTime(show.startsAt, timeZone);
  const doorsTime = formatTime(show.doorsOpenAt, timeZone);
  const mapUrl = venueMapUrl(show.venueName, show.venueAddress);

  /**
   * Counted to the doors, not to the downbeat — the doors time is the one a
   * guest acts on. Falls back to the start time when no doors time is set, and
   * disappears entirely when neither is: half the show columns are nullable and
   * an unconfigured concert must still render a scannable ticket.
   */
  const countdownTarget = show.doorsOpenAt ?? show.startsAt;
  const countdown = cancelled ? null : countdownTo(countdownTarget, new Date());

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
        <TicketCard
          name={status.attendeeName}
          ticketCode={status.ticketCode}
          qr={await qrSvg(status.qrToken)}
          admittedAt={admitted ? formatDateTime(status.admittedAt, timeZone) : null}
          admitted={admitted}
        />
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
 * The ticket itself: the holder's name, the QR, and the code under it.
 *
 * **The ticket code is here on purpose**, though §4.1's list stops at the QR.
 * It is the door's own secondary way in (spec/tickets.md §10.1 rule 4 — the scanner's
 * Search tab takes exactly this string), and this page is what a guest holds up
 * when the QR will not read off their screen. It is their own identifier and
 * discloses nothing further.
 *
 * **The segment is never shown**, here or anywhere on this surface: a guest does
 * not need to know they were in the "public" block (spec/v2.md §13.3).
 */
function TicketCard({
  name,
  ticketCode,
  qr,
  admitted,
  admittedAt,
}: {
  name: string;
  ticketCode: string | null;
  qr: string;
  admitted: boolean;
  admittedAt: string | null;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-xl text-balance">{name}</CardTitle>
        <CardDescription>
          {admitted
            ? admittedAt
              ? `Admitted ${admittedAt}`
              : 'Already admitted'
            : 'Present this QR at the door'}
        </CardDescription>
        {admitted ? (
          <CardAction>
            <Badge variant="secondary">
              <CircleCheckIcon data-icon="inline-start" />
              Checked in
            </Badge>
          </CardAction>
        ) : null}
      </CardHeader>
      <CardContent className="flex flex-col items-center gap-3">
        {/*
         * **Always light, never themed.** The symbol ships its own opaque white
         * background path, and the padding around it extends that plate so the
         * quiet zone survives on a dark page. This is spec/tickets.md §10.4's
         * rendering constraint applied to a screen: a QR on a dark surface is a
         * QR that does not scan.
         *
         * The markup is generated by `qrcode` from our own origin and a
         * shape-checked base62 token, and is checked to be an `<svg>` element
         * before it gets here (`src/lib/portal/qr.ts`).
         */}
        <div
          className="w-full max-w-64 rounded-xl bg-white p-3 [&>svg]:block [&>svg]:h-auto [&>svg]:w-full"
          dangerouslySetInnerHTML={{ __html: qr }}
        />
        {ticketCode ? (
          <p className="font-mono text-lg tracking-[0.2em] tabular-nums">{ticketCode}</p>
        ) : null}
      </CardContent>
    </Card>
  );
}
