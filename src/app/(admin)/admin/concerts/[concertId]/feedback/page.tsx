import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireRole } from '@/lib/auth/guards';
import { AdminOnly } from '@/components/auth/role';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Empty, EmptyDescription, EmptyTitle } from '@/components/ui/empty';
import { formatShowTime } from '../../local-time';
import { getConcertHeader } from '../shows/queries';
import { GenerateFeedbackButton } from './generate-feedback-button';
import { feedbackByShow, type FeedbackShow } from './queries';

export const metadata: Metadata = { title: 'Feedback' };

/**
 * `/admin/concerts/{id}/feedback` — After › Feedback (spec/v3.md §29.1,
 * spec/v2.md §13.5).
 *
 * One card per show, because feedback is addressed per show across both its
 * audiences: its feedback form and responses, whether the portal shows it,
 * who it goes to (everyone admitted, §13.5.1), and where its emails are.
 * **Generate feedback emails** and **Send now** moved here from the show card:
 * they are the manual twins of what completing a show does (§13.5.3), and the
 * After area is where an organiser looks once the evening is over.
 *
 * Nothing on it is contact data, so a viewer is handed what an admin is; the
 * two buttons are `AdminOnly`.
 */
export default async function FeedbackPage({
  params,
}: {
  params: Promise<{ concertId: string }>;
}) {
  await requireRole('ADMIN', 'VIEWER');
  const { concertId: raw } = await params;
  const concertId = Number(raw);
  if (!Number.isInteger(concertId) || concertId <= 0) notFound();

  const concert = await getConcertHeader(concertId);
  if (!concert) notFound();
  const shows = await feedbackByShow(concertId);
  const base = `/admin/concerts/${concertId}`;

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold">Feedback</h1>
        <p className="text-muted-foreground text-sm">
          Each show’s feedback form, and the email that carries it to everyone who was admitted.
        </p>
      </div>

      {shows.length === 0 ? (
        <Empty className="border">
          <EmptyTitle>No shows yet</EmptyTitle>
          <EmptyDescription>Feedback belongs to a show. Add one under Setup › Shows.</EmptyDescription>
        </Empty>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {shows.map((show) => (
            <ShowFeedback key={show.id} base={base} concertId={concertId} show={show} timeZone={concert.timezone} />
          ))}
        </div>
      )}
    </div>
  );
}

const FORM_STATUS: Record<'DRAFT' | 'OPEN' | 'CLOSED', string> = {
  DRAFT: 'Draft',
  OPEN: 'Open',
  CLOSED: 'Closed',
};

function ShowFeedback({
  base,
  concertId,
  show,
  timeZone,
}: {
  base: string;
  concertId: number;
  show: FeedbackShow;
  timeZone: string | null;
}) {
  const completed = show.status === 'COMPLETED';
  const closeAt = show.closeAt ? new Date(show.closeAt) : null;
  const messages = `${base}/audience/messages?purpose=FEEDBACK`;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{show.name}</CardTitle>
        <CardDescription>
          {show.endsAt ? `Ends ${formatShowTime(show.endsAt, timeZone)}` : 'No end time set'}
          {' · '}
          {show.admitted} admitted
        </CardDescription>
        <CardAction>
          <Badge variant={completed ? 'default' : 'secondary'}>{show.status.toLowerCase()}</Badge>
        </CardAction>
      </CardHeader>

      <CardContent className="flex flex-col gap-4 text-sm">
        <section className="flex flex-col gap-2">
          <h3 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">Form</h3>
          {show.forms.length === 0 ? (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-muted-foreground">No feedback form for this show.</span>
              <Button size="sm" variant="outline" nativeButton={false} render={<Link href={`${base}/forms`} />}>
                Go to Forms
              </Button>
            </div>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {show.forms.map((form) => (
                <li key={form.id} className="flex flex-wrap items-center justify-between gap-2">
                  <Link href={`${base}/forms/${form.id}`} className="font-medium underline-offset-4 hover:underline">
                    {form.title}
                  </Link>
                  <span className="flex items-center gap-2">
                    <Badge variant={form.status === 'OPEN' ? 'default' : 'outline'}>{FORM_STATUS[form.status]}</Badge>
                    <Link
                      href={`${base}/forms/${form.id}/responses`}
                      className="text-muted-foreground tabular-nums underline-offset-4 hover:underline"
                    >
                      {form.responses} response{form.responses === 1 ? '' : 's'}
                    </Link>
                  </span>
                </li>
              ))}
            </ul>
          )}
          <p className="text-muted-foreground">
            In the portal:{' '}
            {show.enabled === true ? 'shown' : show.enabled === false ? 'hidden' : 'not set, so hidden'}
            {closeAt ? ` · closes ${formatShowTime(closeAt, timeZone)}` : ''}.{' '}
            <Link href={`${base}/setup`} className="underline underline-offset-4">
              Change it in Setup › Concert
            </Link>
            .
          </p>
        </section>

        <section className="flex flex-col gap-2">
          <h3 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">Email</h3>
          <p className="flex flex-wrap gap-x-4 gap-y-1">
            <Link href={messages} className="underline-offset-4 hover:underline">
              <span className="font-medium tabular-nums">{show.emails.sent}</span> sent
            </Link>
            <Link href={messages} className="underline-offset-4 hover:underline">
              <span className="font-medium tabular-nums">{show.emails.waiting}</span> waiting
            </Link>
            <Link href={messages} className="underline-offset-4 hover:underline">
              <span
                className={show.emails.failed > 0 ? 'text-destructive font-medium tabular-nums' : 'font-medium tabular-nums'}
              >
                {show.emails.failed}
              </span>{' '}
              failed
            </Link>
          </p>
          {/* The audience only exists once the evening is over, so the
              controls appear with the status that says so (§13.5.3). */}
          {completed ? (
            <AdminOnly>
              <GenerateFeedbackButton concertId={concertId} showId={show.id} />
            </AdminOnly>
          ) : (
            <p className="text-muted-foreground">
              Completing the show queues one email per admitted party, sent at the feedback send hour.
            </p>
          )}
        </section>
      </CardContent>
    </Card>
  );
}
