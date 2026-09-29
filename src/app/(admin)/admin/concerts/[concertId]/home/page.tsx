import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  ArrowRight,
  CheckCircle2,
  Circle,
  CircleAlert,
  Clock,
  PartyPopper,
} from 'lucide-react';
import { requireRole } from '@/lib/auth/guards';
import { maskForRole } from '@/lib/auth/mask';
import { resolveSetting } from '@/db/settings';
import { viewCounts } from '@/lib/audience/queries';
import { FLAG_LABEL, STAGE_LABEL, STAGE_NEXT, STAGES, type Flag } from '@/lib/audience/filter';
import { inboxCounts, mailboxStatus } from '@/lib/inbox/queries';
import { listBatches } from '@/lib/import/staging-queries';
import { lastHeartbeat } from '@/lib/scheduler/tick';
import { buildChecklist, heartbeatState, type ChecklistPhase, type HeartbeatState } from '@/lib/home/checklist';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { cn } from '@/lib/utils';
import { formatShowTime } from '../../local-time';
import { getConcertHeader, getShowsForConcert, type ShowView } from '../shows/queries';
import { checklistFacts, concertForms, seatFunnel, type FormDate, type SeatFunnel } from './queries';
import { CheckAddressesButton } from './check-addresses';

export const metadata: Metadata = { title: 'Home' };

/**
 * `/admin/concerts/{id}/home` — the concert at a glance (spec/v3.md §29.2).
 *
 * In the order §29.2 gives: **what needs a person** first, each count linking
 * to the view that holds it; then the funnel; then the dates ahead; then the
 * setup checklist by phase (§29.3). The scheduler's heartbeat is a warning
 * above all of it when it is late, and one line in the header when it is not.
 *
 * It replaces the Overview. Nothing here is computed that another screen
 * already computes: the counts are `party_pipeline`'s, through the same
 * `viewCounts()` the Audience workspace uses, so a number on Home is the number
 * of rows its link opens.
 */
export default async function HomePage({
  params,
}: {
  params: Promise<{ concertId: string }>;
}) {
  const user = await requireRole('ADMIN', 'VIEWER');
  const { concertId: raw } = await params;
  const concertId = Number(raw);
  if (!Number.isInteger(concertId) || concertId <= 0) notFound();

  const concert = await getConcertHeader(concertId);
  if (!concert) notFound();

  const [counts, inbox, batches, mailbox, heartbeat, tickMinutes, shows, forms, seats] =
    await Promise.all([
      viewCounts(concertId, {}),
      inboxCounts(concertId),
      listBatches(concertId),
      mailboxStatus(),
      lastHeartbeat(),
      resolveSetting<number>('scheduler.tick_minutes'),
      getShowsForConcert(concertId),
      concertForms(concertId),
      seatFunnel(concertId),
    ]);
  const facts = await checklistFacts(concertId, shows, forms, counts.views['suspicious-address'] ?? 0);

  const now = new Date();
  const base = `/admin/concerts/${concertId}`;
  const tz = concert.timezone;
  const beat = heartbeatState(heartbeat, typeof tickMinutes === 'number' ? tickMinutes : null, now);

  const attention = needsAttention(base, counts.views, inbox.waiting, batches, mailbox.folders);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold">{concert.name}</h1>
        <p className="text-muted-foreground text-sm">
          {shows.length === 0 ? 'No shows yet' : `${shows.length} show${shows.length === 1 ? '' : 's'}`}
          {' · '}
          {counts.all} part{counts.all === 1 ? 'y' : 'ies'}
          {tz ? ` · ${tz}` : ''}
          {beat.kind === 'ok' ? ` · scheduler ran ${ago(beat.at, now)}` : ''}
        </p>
      </div>

      {/* The heartbeat's own error text is the tick's; masked like every
          string a viewer is handed. */}
      <HeartbeatAlert state={maskForRole(user.role, beat)} now={now} />

      <section aria-labelledby="attention" className="flex flex-col gap-3">
        <h2 id="attention" className="font-semibold">
          Needs attention
        </h2>
        {attention.length === 0 ? (
          <p className="text-muted-foreground flex items-center gap-2 text-sm">
            <PartyPopper className="size-4" />
            Nothing is waiting on a person right now.
          </p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {attention.map((entry) => (
              <Link
                key={entry.key}
                href={entry.href}
                className="group bg-card hover:bg-muted/50 focus-visible:ring-ring flex flex-col gap-1 rounded-lg border p-4 transition-colors focus-visible:ring-2 focus-visible:outline-none"
              >
                <span className="flex items-center justify-between gap-2">
                  <span className="text-muted-foreground text-sm">{entry.label}</span>
                  <ArrowRight className="text-muted-foreground size-4 opacity-0 transition-opacity group-hover:opacity-100" />
                </span>
                <span className="text-2xl font-semibold tabular-nums">{entry.count}</span>
                {entry.hint ? <span className="text-muted-foreground text-xs">{entry.hint}</span> : null}
              </Link>
            ))}
          </div>
        )}
      </section>

      <Funnel base={base} views={counts.views} seats={seats} shows={shows} />

      <div className="grid gap-6 xl:grid-cols-[2fr_3fr]">
        <Dates base={base} shows={shows} forms={forms} timeZone={tz} now={now} />
        <Checklist concertId={concertId} phases={buildChecklist(facts)} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Needs attention
// ---------------------------------------------------------------------------

type AttentionEntry = { key: string; label: string; count: number; href: string; hint: string | null };

/** What each flag asks of a person, in the admin's words. */
const FLAG_HINT: Partial<Record<Flag, string>> = {
  BOUNCED: 'Fix the address and resend',
  SEND_FAILED: 'Resend, or mark delivered by hand',
  SUSPICIOUS_ADDRESS: 'Fix it, or accept it as it is',
  CHANGED_AFTER_SEND: 'Reissue the tickets',
  POSSIBLE_DUPLICATE: 'Merge, or mark not a duplicate',
  UNNAMED_GUESTS: 'Ask for names, or leave them as placeholders',
  OVER_CAPACITY: 'Seats confirmed above capacity by override',
};

/**
 * Only what is non-zero, in the order a person works through it: parties
 * waiting on a decision, then deliveries that failed, then everything else.
 * `REPLY_WAITING` is left to the Inbox count, which also covers players'
 * threads that the party flag cannot (spec/v3.md §26).
 */
function needsAttention(
  base: string,
  views: Record<string, number>,
  waiting: number,
  batches: Awaited<ReturnType<typeof listBatches>>,
  folders: { folder: string; lastError: string | null }[],
): AttentionEntry[] {
  const entries: AttentionEntry[] = [];
  const add = (entry: AttentionEntry) => {
    if (entry.count > 0) entries.push(entry);
  };
  const view = (id: string) => `${base}/audience?view=${id}`;

  add({ key: 'needs-review', label: STAGE_LABEL.NEEDS_REVIEW, count: views['needs-review'] ?? 0, href: view('needs-review'), hint: STAGE_NEXT.NEEDS_REVIEW });
  add({ key: 'inbox', label: 'Replies waiting', count: waiting, href: `${base}/inbox`, hint: 'Answer, or mark handled' });
  const flags: Flag[] = ['BOUNCED', 'SEND_FAILED', 'SUSPICIOUS_ADDRESS', 'CHANGED_AFTER_SEND', 'POSSIBLE_DUPLICATE', 'OVER_CAPACITY', 'UNNAMED_GUESTS'];
  for (const flag of flags) {
    const id = flag.toLowerCase().replaceAll('_', '-');
    add({ key: id, label: FLAG_LABEL[flag], count: views[id] ?? 0, href: view(id), hint: FLAG_HINT[flag] ?? null });
  }
  add({ key: 'unverified', label: STAGE_LABEL.UNVERIFIED, count: views['unverified'] ?? 0, href: view('unverified'), hint: STAGE_NEXT.UNVERIFIED });

  const unfinished = batches.filter((batch) => batch.staged > 0);
  if (unfinished.length === 1) {
    const batch = unfinished[0]!;
    add({ key: 'import', label: 'Staged import rows', count: batch.staged, href: `${base}/import/${batch.id}?view=needs-fixing`, hint: `${batch.filename} is not committed yet` });
  } else {
    add({ key: 'import', label: 'Staged import rows', count: unfinished.reduce((n, b) => n + b.staged, 0), href: `${base}/import`, hint: `Across ${unfinished.length} imports not committed yet` });
  }

  const failing = folders.filter((folder) => folder.lastError);
  add({ key: 'mailbox', label: 'Mailbox folders failing to sync', count: failing.length, href: `${base}/inbox`, hint: 'Replies and bounces are not being read' });
  return entries;
}

// ---------------------------------------------------------------------------
// The heartbeat
// ---------------------------------------------------------------------------

function ago(at: string, now: Date): string {
  const minutes = Math.max(0, Math.floor((now.getTime() - new Date(at).getTime()) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} days ago`;
}

function HeartbeatAlert({ state, now }: { state: HeartbeatState; now: Date }) {
  switch (state.kind) {
    case 'ok':
      return null;
    case 'unscheduled':
      return (
        <Alert>
          <Clock />
          <AlertTitle>The scheduler is not set up yet</AlertTitle>
          <AlertDescription>
            Nothing runs on a timer until pg_cron is scheduled and its interval is set (`local.md`
            §16). Until then, receipts and timed sends wait for the daily run, and the Inbox is read
            only while a console is open.
          </AlertDescription>
        </Alert>
      );
    case 'never':
      return (
        <Alert variant="destructive">
          <CircleAlert />
          <AlertTitle>The scheduler has never run</AlertTitle>
          <AlertDescription>
            An interval is set but no tick has been recorded. Check that the pg_cron job exists and
            can reach the tick route.
          </AlertDescription>
        </Alert>
      );
    case 'stale':
      return (
        <Alert variant="destructive">
          <CircleAlert />
          <AlertTitle>The scheduler last ran {ago(state.at, now)}</AlertTitle>
          <AlertDescription>
            That is more than three ticks late. Receipts, timed sends and the mailbox wait until it
            runs again.
          </AlertDescription>
        </Alert>
      );
    case 'failed':
      return (
        <Alert variant="destructive">
          <CircleAlert />
          <AlertTitle>The last scheduler tick failed ({ago(state.at, now)})</AlertTitle>
          <AlertDescription className="whitespace-pre-wrap">{state.error}</AlertDescription>
        </Alert>
      );
  }
}

// ---------------------------------------------------------------------------
// The funnel
// ---------------------------------------------------------------------------

function Funnel({
  base,
  views,
  seats,
  shows,
}: {
  base: string;
  views: Record<string, number>;
  seats: SeatFunnel;
  shows: ShowView[];
}) {
  const seatSteps: [string, number][] = [
    ['Live', seats.live],
    ['Confirmed', seats.confirmed],
    ['Issued', seats.issued],
    ['Delivered', seats.delivered],
    ['Admitted', seats.admitted],
  ];
  const segments = shows.flatMap((show) =>
    show.segments.map((segment) => ({ show, segment })),
  );

  return (
    <section aria-labelledby="funnel" className="flex flex-col gap-3">
      <h2 id="funnel" className="font-semibold">
        Where every party is
      </h2>
      <Card>
        <CardContent className="flex flex-col gap-5">
          {/* One tile per stage, in pipeline order (spec/v3.md §21.1). A party
              is in exactly one stage, so the tiles sum to every party. */}
          <ol className="grid grid-cols-2 gap-px overflow-hidden rounded-md border sm:grid-cols-4 lg:grid-cols-8">
            {STAGES.map((stage) => {
              const id = stage.toLowerCase().replaceAll('_', '-');
              const count = views[id] ?? 0;
              return (
                <li key={stage} className="bg-border">
                  <Link
                    href={`${base}/audience?view=${id}`}
                    className="bg-card hover:bg-muted/50 focus-visible:ring-ring flex h-full flex-col gap-0.5 p-3 transition-colors focus-visible:ring-2 focus-visible:outline-none focus-visible:ring-inset"
                  >
                    <span className="text-muted-foreground text-xs">{STAGE_LABEL[stage]}</span>
                    <span className={cn('text-lg font-semibold tabular-nums', count === 0 && 'text-muted-foreground')}>
                      {count}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ol>

          <div className="flex flex-col gap-1">
            <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">Seats</p>
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
              {seatSteps.map(([label, value], index) => (
                <span key={label} className="flex items-center gap-2">
                  {index > 0 ? <ArrowRight className="text-muted-foreground size-3.5" /> : null}
                  <span>
                    <span className="font-semibold tabular-nums">{value}</span>{' '}
                    <span className="text-muted-foreground">{label.toLowerCase()}</span>
                  </span>
                </span>
              ))}
            </p>
          </div>

          {segments.length > 0 ? (
            <div className="grid gap-x-8 gap-y-3 md:grid-cols-2">
              {segments.map(({ show, segment }) => {
                const pool = segment.pool;
                return (
                  <div key={segment.id} className="flex flex-col gap-1.5">
                    <div className="flex items-baseline justify-between gap-2 text-sm">
                      <span className="truncate">
                        {show.name} <span className="text-muted-foreground">· {segment.name}</span>
                      </span>
                      <span className="text-muted-foreground shrink-0 tabular-nums">
                        {pool === null ? (
                          'no capacity set'
                        ) : (
                          <>
                            <span className="text-foreground font-medium">{pool.confirmed}</span> of{' '}
                            {pool.sellable} confirmed
                            {pool.over > 0 ? <span className="text-destructive"> · {pool.over} over</span> : null}
                          </>
                        )}
                      </span>
                    </div>
                    {pool !== null ? (
                      <Progress
                        value={pool.sellable > 0 ? Math.min(100, (pool.confirmed / pool.sellable) * 100) : 0}
                        aria-label={`${show.name} · ${segment.name}: ${pool.confirmed} of ${pool.sellable} confirmed`}
                      />
                    ) : null}
                  </div>
                );
              })}
            </div>
          ) : null}
        </CardContent>
      </Card>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

type DateEntry = { key: string; at: Date; label: string; detail: string; href: string };

/** How many past dates stay on the list, most recent first above the rest. */
const PAST_SHOWN = 3;

function dateEntries(base: string, shows: ShowView[], forms: FormDate[]): DateEntry[] {
  const entries: DateEntry[] = [];
  const showName = new Map(shows.map((show) => [show.id, show.name]));
  const segmentLabel = new Map(
    shows.flatMap((show) => show.segments.map((segment) => [segment.id, `${show.name} · ${segment.name}`] as const)),
  );

  for (const form of forms) {
    if (form.status === 'DRAFT') continue;
    const parent =
      (form.segmentId !== null ? segmentLabel.get(form.segmentId) : null) ??
      (form.showId !== null ? showName.get(form.showId) : null) ??
      '';
    const href = `${base}/forms/${form.id}/settings`;
    if (form.opensAt) entries.push({ key: `fo${form.id}`, at: form.opensAt, label: `“${form.title}” opens`, detail: parent, href });
    if (form.closesAt) entries.push({ key: `fc${form.id}`, at: form.closesAt, label: `“${form.title}” closes`, detail: parent, href });
  }

  for (const show of shows) {
    for (const segment of show.segments) {
      const deadline = segment.resolved['allocation.base_claim_deadline']?.value;
      if (segment.audienceMode === 'PLAYER_INVITED' && deadline) {
        const at = new Date(String(deadline));
        if (!Number.isNaN(at.getTime())) {
          entries.push({ key: `cd${segment.id}`, at, label: 'Claim deadline', detail: `${show.name} · ${segment.name}`, href: `${base}/shows` });
        }
      }
    }
    if (show.doorsOpenAt) entries.push({ key: `do${show.id}`, at: show.doorsOpenAt, label: 'Doors open', detail: show.name, href: `${base}/shows` });
    if (show.startsAt) entries.push({ key: `ss${show.id}`, at: show.startsAt, label: 'Show starts', detail: show.name, href: `${base}/shows` });
    if (show.endsAt) entries.push({ key: `se${show.id}`, at: show.endsAt, label: 'Show ends', detail: show.name, href: `${base}/shows` });
  }

  return entries.sort((a, b) => a.at.getTime() - b.at.getTime());
}

function Dates({
  base,
  shows,
  forms,
  timeZone,
  now,
}: {
  base: string;
  shows: ShowView[];
  forms: FormDate[];
  timeZone: string | null;
  now: Date;
}) {
  const all = dateEntries(base, shows, forms);
  const past = all.filter((entry) => entry.at < now).slice(-PAST_SHOWN);
  const upcoming = all.filter((entry) => entry.at >= now);
  const shown = [...past, ...upcoming];

  return (
    <section aria-labelledby="dates" className="flex flex-col gap-3">
      <h2 id="dates" className="font-semibold">
        Dates
      </h2>
      <Card>
        <CardContent>
          {shown.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              No dates yet. Show times, claim deadlines and form windows appear here once they are set.
            </p>
          ) : (
            <ol className="flex flex-col">
              {shown.map((entry, index) => {
                const isPast = entry.at < now;
                const isNext = !isPast && (index === 0 || shown[index - 1]!.at < now);
                return (
                  <li key={entry.key} className={cn('border-b last:border-0', isPast && 'text-muted-foreground')}>
                    <Link
                      href={entry.href}
                      className="hover:bg-muted/50 -mx-2 flex items-baseline justify-between gap-3 rounded-md px-2 py-2 text-sm"
                    >
                      <span className="min-w-0">
                        <span className={cn('font-medium', isPast && 'font-normal')}>{entry.label}</span>
                        {entry.detail ? <span className="text-muted-foreground"> · {entry.detail}</span> : null}
                        {isNext ? (
                          <Badge variant="secondary" className="ml-2">
                            Next
                          </Badge>
                        ) : null}
                      </span>
                      <time dateTime={entry.at.toISOString()} className="shrink-0 tabular-nums">
                        {formatShowTime(entry.at, timeZone)}
                      </time>
                    </Link>
                  </li>
                );
              })}
            </ol>
          )}
        </CardContent>
      </Card>
    </section>
  );
}

// ---------------------------------------------------------------------------
// The setup checklist
// ---------------------------------------------------------------------------

function Checklist({ concertId, phases }: { concertId: number; phases: ChecklistPhase[] }) {
  return (
    <section aria-labelledby="checklist" className="flex flex-col gap-3">
      <h2 id="checklist" className="font-semibold">
        Setup checklist
      </h2>
      <div className="grid gap-3 md:grid-cols-2">
        {phases.map((phase) => {
          const left = phase.items.filter((entry) => !entry.done).length;
          return (
            <Card key={phase.id} size="sm">
              <CardHeader>
                <CardTitle>{phase.label}</CardTitle>
                <CardDescription>
                  {left === 0 ? 'All set.' : `${left} of ${phase.items.length} still to do.`}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <ul className="flex flex-col gap-2">
                  {phase.items.map((entry) => (
                    <li key={entry.id} className="flex gap-2 text-sm">
                      {entry.done ? (
                        <CheckCircle2 aria-label="Done" className="text-primary mt-0.5 size-4 shrink-0" />
                      ) : (
                        <Circle aria-label="To do" className="text-muted-foreground mt-0.5 size-4 shrink-0" />
                      )}
                      <span className="flex min-w-0 flex-col gap-1">
                        <Link
                          href={entry.href}
                          className={cn('underline-offset-4 hover:underline', entry.done && 'text-muted-foreground')}
                        >
                          {entry.label}
                        </Link>
                        {!entry.done && entry.detail ? (
                          <span className="text-muted-foreground text-xs">{entry.detail}</span>
                        ) : null}
                        {!entry.done && entry.fix === 'audience.check_address' ? (
                          <span>
                            <CheckAddressesButton concertId={concertId} />
                          </span>
                        ) : null}
                      </span>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </section>
  );
}
