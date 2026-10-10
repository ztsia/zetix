'use client';

import { useState } from 'react';
import { CalendarDaysIcon, ChevronRightIcon, MapPinIcon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Item, ItemActions, ItemContent, ItemDescription, ItemMedia, ItemTitle } from '@/components/ui/item';
import { FeedbackSection } from '@/components/portal/feedback-section';
import { NotesSection } from '@/components/portal/notes-section';
import { PracticalSection } from '@/components/portal/practical-section';
import { TicketSection, TicketStub } from '@/components/portal/ticket-section';
import { WallSection } from '@/components/portal/wall-section';
import { validateAnswers } from '@/lib/forms/answers';
import { countdownTo, formatDate, formatDateTime, formatTime, venueMapUrl } from '@/lib/portal/format';
import { Countdown } from '@/app/(portal)/t/[token]/countdown';
import {
  CONCERT,
  FEEDBACK_SCHEMA,
  FEEDBACK_TITLE,
  GALA,
  GUEST,
  localAt,
  NOTE_MAX_LENGTH,
  PARTY_SIZE,
  PLAYERS,
  PRACTICAL,
  REHEARSAL,
  TICKET_CODE,
  TIME_ZONE,
  WALL,
} from '../_lib/guest';

/** What the links on these pages do in the real portal; the phone says so instead of following them. */
export const GUEST_LINKS = {
  'google.com/maps': 'In the real portal, this opens the venue in Google Maps.',
  'showcase-ticket': 'In the real portal, this saves her ticket as a PDF.',
};

/** Stands in for the portal's own path, so the phone can tell the download apart. */
const PDF = '/showcase-ticket';
/** The token the real actions take; nothing here sends it anywhere. */
const TOKEN = 'showcase';

const settle = () => new Promise((resolve) => window.setTimeout(resolve, 650));

/**
 * The feedback form's submit, answered in the browser. The same validation the server action runs
 * (`validateAnswers` against the form's schema), so a missing rating is refused here as it is there;
 * nothing is stored.
 */
async function submitFeedback(_token: string, payload: unknown) {
  await settle();
  const result = validateAnswers(FEEDBACK_SCHEMA, payload, { limits: {} });
  return result.ok ? { ok: true, errors: {} } : { ok: false, errors: result.errors };
}

/** The note's submit, with the server action's two refusals (`notes-actions.ts`); nothing is stored. */
async function submitNote(_token: string, payload: unknown): Promise<{ ok: boolean; errors: Record<string, string> }> {
  await settle();
  const body = String((payload as { body?: unknown } | null)?.body ?? '').trim();
  if (body.length === 0) return { ok: false, errors: { body: 'Write something first.' } };
  if (body.length > NOTE_MAX_LENGTH) {
    return {
      ok: false,
      errors: { body: `Please keep this to ${NOTE_MAX_LENGTH} characters — yours is ${body.length}.` },
    };
  }
  return { ok: true, errors: {} };
}

/** The page's header and venue row, as `/t/[token]` draws them (`src/app/(portal)/t/[token]/page.tsx`). */
function Facts({
  show,
  venue,
  doors,
  starts,
  countdown,
}: {
  show: string;
  venue: string;
  doors: Date;
  starts: Date;
  countdown: boolean;
}) {
  const [now] = useState(() => new Date());
  const when = [formatDate(starts, TIME_ZONE), `Doors ${formatTime(doors, TIME_ZONE)}`, `Starts ${formatTime(starts, TIME_ZONE)}`].join(' · ');
  const left = countdown ? countdownTo(doors, now) : null;
  const mapUrl = venueMapUrl(venue, null);
  return (
    <>
      <header className="space-y-3 text-center">
        <div className="space-y-1">
          <p className="text-sm text-muted-foreground">{CONCERT}</p>
          <h1 className="text-2xl font-semibold tracking-tight text-balance">{show}</h1>
        </div>
        <p className="flex items-center justify-center gap-2 text-base text-foreground/80">
          <CalendarDaysIcon className="size-4 shrink-0" aria-hidden />
          {when}
        </p>
        {left && !left.open ? (
          <Badge variant="secondary" className="text-sm">
            {'Doors open '}
            <Countdown targetIso={doors.toISOString()} initialLabel={`in ${left.label}`} openLabel="Doors are open" />
          </Badge>
        ) : null}
      </header>
      <Item variant="outline" className="min-h-12" render={mapUrl ? <a href={mapUrl} /> : undefined}>
        <ItemMedia variant="icon">
          <MapPinIcon />
        </ItemMedia>
        <ItemContent>
          <ItemTitle className="text-base">{venue}</ItemTitle>
          <ItemDescription>Free seating — sit anywhere you like.</ItemDescription>
        </ItemContent>
        <ItemActions>
          <ChevronRightIcon className="size-4 text-muted-foreground" aria-hidden />
        </ItemActions>
      </Item>
    </>
  );
}

/** Eleanor's ticket page three weeks before the gala: the QR the door admits, then before-you-come. */
export function GuestTicket({ qr }: { qr: string }) {
  const [{ doors, starts }] = useState(() => ({
    doors: localAt(GALA.inDays, GALA.doors),
    starts: localAt(GALA.inDays, GALA.starts),
  }));
  return (
    <main className="flex flex-col gap-5 px-4 py-8">
      <Facts show={GALA.name} venue={GALA.venue} doors={doors} starts={starts} countdown />
      <TicketSection
        name={GUEST}
        ticketCode={TICKET_CODE}
        qr={qr}
        admitted={false}
        admittedAt={null}
        downloadHref={PDF}
        partySize={PARTY_SIZE}
      />
      <PracticalSection markdown={PRACTICAL} />
    </main>
  );
}

/**
 * Her page after the open rehearsal, in the portal's after-the-show order: the feedback form first,
 * then a note for the players, the wall, before-you-come, and her ticket folded to a stub.
 */
export function GuestAfter() {
  const [{ doors, starts, admitted }] = useState(() => ({
    doors: localAt(REHEARSAL.inDays, REHEARSAL.doors),
    starts: localAt(REHEARSAL.inDays, REHEARSAL.starts),
    admitted: localAt(REHEARSAL.inDays, REHEARSAL.admitted),
  }));
  return (
    <main className="flex flex-col gap-5 px-4 py-8">
      <Facts show={REHEARSAL.name} venue={REHEARSAL.venue} doors={doors} starts={starts} countdown={false} />
      <FeedbackSection
        token={TOKEN}
        formId={1}
        schema={FEEDBACK_SCHEMA}
        title={FEEDBACK_TITLE}
        descriptionMd={null}
        copy={{}}
        existing={null}
        submit={submitFeedback}
      />
      <NotesSection
        token={TOKEN}
        state="OPEN"
        players={PLAYERS}
        defaultToPlayerId={null}
        existing={null}
        maxLength={NOTE_MAX_LENGTH}
        submit={submitNote}
      />
      <WallSection notes={WALL} />
      <PracticalSection markdown={PRACTICAL} />
      <TicketStub name={GUEST} admitted admittedAt={formatDateTime(admitted, TIME_ZONE)} downloadHref={PDF} />
    </main>
  );
}
