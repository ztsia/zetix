import {
  CalendarClockIcon,
  ClockAlertIcon,
  SearchXIcon,
  TicketXIcon,
  WrenchIcon,
} from 'lucide-react';
import { FormHeaderCard } from '@/components/forms/form-surface';
import { formatDateTime } from '@/lib/portal/format';

/**
 * Everything `/f/{slug}` renders when it is not rendering a form.
 *
 * All five are the same shape — icon, one line of what happened, one line of
 * what to do — because from the reader's side they are the same event: they
 * followed a link and there is nothing to fill in. The differences that matter
 * to us (a draft form, an unparseable schema, a segment nobody configured) are
 * differences about *us*, and none of them is the reader's to act on.
 *
 * **Nothing here is a `notFound()`.** The `/t/{token}` page settled this for the
 * portal (`v2.md` §13.2) and the argument carries: these URLs are printed on
 * posters and pasted into group chats, and a framework 404 tells someone their
 * link is broken when the truth is usually that they are early, or late.
 */

/**
 * Shared frame, so the five states cannot drift apart in spacing or tone.
 *
 * Google Forms' own "this form is no longer accepting responses" page: the
 * header card, with its accent band, holding the title and one line of what to
 * do. The icon stays, small, beside the title — it is what tells "not yet" from
 * "no longer" at a glance.
 */
function State({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <FormHeaderCard
      title={
        <span className="flex items-start gap-3">
          <span className="text-form-accent mt-1.5 shrink-0 [&_svg]:size-6 sm:mt-2" aria-hidden>
            {icon}
          </span>
          <span>{title}</span>
        </span>
      }
      description={<p className="text-muted-foreground">{children}</p>}
    />
  );
}

/**
 * No such form — and also a draft one, and one whose schema no longer parses.
 *
 * **One response for all three**, following `loadFormBySlug`'s own rule and the
 * ticket page's: a slug is a guessable thing, and telling a prober that a draft
 * form exists at this address is telling them the address is worth watching.
 */
export function FormNotFound() {
  return (
    <State icon={<SearchXIcon />} title="This form is not available">
      The link may be mistyped, or the form may have been taken down. If someone sent you this link,
      ask them to check it.
    </State>
  );
}

/**
 * Closed, or outside its window.
 *
 * The two are one screen with a different sentence, because "not yet" and "no
 * longer" are the only facts the reader can act on. A form that opens later
 * names the time; one that has closed does not offer a countdown to nothing.
 */
export function FormClosed({
  title,
  opensAt,
  closesAt,
  timeZone,
  now,
}: {
  title: string;
  opensAt: Date | null;
  closesAt: Date | null;
  timeZone: string | null;
  now: Date;
}) {
  const notYet = opensAt !== null && now < opensAt;
  /**
   * In `concert.timezone`, never the reader's (`CLAUDE.md`). Someone opening
   * this from another country must see the time the orchestra means, and a form
   * that says the wrong opening time is the same failure as a ticket that says
   * the wrong door time.
   */
  const opens = formatDateTime(opensAt, timeZone);
  const closed = formatDateTime(closesAt, timeZone);

  if (notYet) {
    return (
      <State icon={<CalendarClockIcon />} title={`${title} has not opened yet`}>
        {opens ? `Registration opens ${opens}.` : 'Registration has not opened yet.'} Please come
        back then.
      </State>
    );
  }

  return (
    <State icon={<ClockAlertIcon />} title={`${title} has closed`}>
      {closed ? `Registration closed ${closed}.` : 'Registration for this form has closed.'} If you
      still need a seat, please contact the orchestra.
    </State>
  );
}

/**
 * The form is fine; its segment is not configured, so a repeater cap resolved to
 * nothing.
 *
 * **This is `limits.ts`'s refusal reaching the screen, and it must stay a
 * refusal.** Rendering a repeater with an invented cap is the one failure that
 * could take more seats than exist (`CLAUDE.md`, `README.md` §2.1). The reader
 * is told only that it is not open — `missing` names setting keys, which are our
 * business and would mean nothing to them — and it is logged for whoever has to
 * fix it.
 */
export function FormNotConfigured({ title, missing }: { title: string; missing: string[] }) {
  console.error(
    `registration form "${title}" cannot render: unresolved settings — ${missing.join(', ')}`,
  );
  return (
    <State icon={<WrenchIcon />} title="This form is not open yet">
      It is still being set up. Please check back shortly, or contact the orchestra if you were
      expecting it to be ready.
    </State>
  );
}

/**
 * Every seat is taken.
 *
 * Distinct from `FormClosed` on purpose: a form that closed on time and a form
 * that ran out are different facts, and someone who arrives to a full house is
 * better served by being told so plainly than by "registration has closed",
 * which reads as though they missed a deadline that never applied to them.
 */
export function FormFull({ title }: { title: string }) {
  return (
    <State icon={<TicketXIcon />} title={`${title} is full`}>
      Every seat has been taken. If more become available the orchestra will reopen registration, so
      it is worth checking back.
    </State>
  );
}

/**
 * The per-IP throttle, as a page rather than a `429`.
 *
 * A page in the App Router cannot return a `429` with a `Retry-After` — which
 * is exactly why `K` also exposes `GET /api/forms/{slug}` — so the limit is
 * rendered instead. The wait is named because the limiter keeps that promise:
 * a refused request is not recorded, so the number does not move while someone
 * waits on it.
 */
export function FormThrottled({ retryAfterSeconds }: { retryAfterSeconds: number }) {
  return (
    <State icon={<ClockAlertIcon />} title="Too many requests">
      Please wait {retryAfterSeconds} second{retryAfterSeconds === 1 ? '' : 's'} and reload the page.
    </State>
  );
}
