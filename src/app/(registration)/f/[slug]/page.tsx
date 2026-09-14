import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { segmentPool } from '@/db/allocation';
import { resolveSetting } from '@/db/settings';
import { RichText } from '@/components/forms/rich-text';
import { clientIp, consumeRateLimit, formBucket } from '@/lib/auth/rate-limit';
import { loadFormBySlug } from '@/lib/forms/load';
import { resolveRegistrant } from '@/lib/forms/registrant';
import { seatIndicator } from '@/lib/forms/seat-indicator';
import { RegistrationForm } from './registration-form';
import {
  FormClosed,
  FormFull,
  FormNotConfigured,
  FormNotFound,
  FormThrottled,
} from './states';

/**
 * `/f/{slug}` — the public registration form, and `?k={token}` the player's
 * (spec/v2.md §8.1, `surfaces.md` §15.2).
 *
 * The first page in `K`'s `(registration)` route group, which until now held a
 * layout and nothing else.
 *
 * **This page decides nothing about seats.** It resolves who is asking, asks
 * `loadFormBySlug` what to render, and hands the whole thing to the renderer.
 * Every cap it passes down came from the cascade and every one of them is
 * **advisory** — `claim_seats()` is the truth, and the reconciliation lives in
 * the submit action next door (§8.3).
 */

/**
 * `node`, because the submit action beside this page resolves DNS to check an
 * address can be delivered to (`lib/email/address.ts`) and queues outbox rows.
 * A Server Action inherits its page's runtime, so it is declared here.
 */
export const runtime = 'nodejs';

/**
 * Never cached, and this one is not a preference.
 *
 * The page renders a live seat count, a form whose window may have closed a
 * second ago, and — with `?k=` — **one named player's prefilled details**. A
 * cached copy of that last one is one player's name and email served to the
 * next visitor, which is the worst outcome this surface has available.
 */
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  /** The token in the URL is the credential (`ref.md` §7), restated here. */
  robots: { index: false, follow: false },
};

export default async function RegistrationFormPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ k?: string | string[] }>;
}) {
  /**
   * **Throttle first, before any lookup** (`K`'s contract, `ref.md` §7). A
   * throttle that runs after the form has been fetched has already let the
   * caller use this route to enumerate slugs, which is the whole thing it is
   * here to stop.
   *
   * No cascade context is passed: at this point nothing has been looked up, and
   * looking a form up in order to decide whether to allow the lookup is the
   * wrong way round.
   */
  const verdict = await consumeRateLimit(formBucket(clientIp(await headers())));
  if (!verdict.allowed) return <FormThrottled retryAfterSeconds={verdict.retryAfterSeconds} />;

  const { slug } = await params;
  const query = await searchParams;
  // A repeated `?k=` gives an array. Neither entry is more correct than the
  // other, so it is not a token rather than a coin toss over someone's identity.
  const token = typeof query.k === 'string' ? query.k : null;

  const now = new Date();

  /**
   * Loaded twice, deliberately, and only when there is a token.
   *
   * `resolveRepeaterLimits` sizes the base repeater from
   * `baseAlreadyClaimed`, and that number cannot be counted until the player is
   * resolved — which needs the concert, which comes from the form. The first
   * load is what identifies the concert; the second is what sizes the rows.
   * A public form never takes this path.
   */
  const first = await loadFormBySlug(slug, { now });
  if (first.state === 'NOT_FOUND') return <FormNotFound />;

  const registrant =
    first.state === 'OPEN'
      ? await resolveRegistrant(token, first.concertId, first.segmentId)
      : { kind: 'ANONYMOUS' as const };

  const form =
    first.state === 'OPEN' && registrant.kind === 'PLAYER' && registrant.baseAlreadyClaimed > 0
      ? await loadFormBySlug(slug, { now, baseAlreadyClaimed: registrant.baseAlreadyClaimed })
      : first;

  if (form.state === 'NOT_FOUND') return <FormNotFound />;
  if (form.state === 'CLOSED') {
    return (
      <FormClosed
        title={form.title}
        opensAt={form.opensAt}
        closesAt={form.closesAt}
        // `CLOSED` carries no timezone — it is reached before the concert is
        // joined — so the times render unzoned rather than in the reader's.
        timeZone={null}
        now={now}
      />
    );
  }
  if (form.state === 'NOT_CONFIGURED') {
    return <FormNotConfigured title={form.title} missing={form.missing} />;
  }

  /**
   * The live pool, for the indicator and for the full state.
   *
   * **Read outside any lock and immediately stale** (§8.3). It is a hint about
   * what is likely, never a reservation, and the submit path reconciles against
   * the engine's real answer.
   *
   * A `FEEDBACK` form has no segment and no seats; it never reaches this page
   * anyway — it is answered from the portal, which is `N`'s — but the null
   * check is what makes that true rather than assumed.
   */
  const pool = form.segmentId === null ? null : await segmentPool(form.segmentId);
  const exactBelow = await resolveSetting<number>('form.seat_indicator_exact_below', {
    segmentId: form.segmentId,
    showId: form.showId,
    concertId: form.concertId,
  });
  const indicator = pool === null ? null : seatIndicator(pool.extras_pool, exactBelow);

  /**
   * Full closes the form to new parties.
   *
   * A player holding unclaimed base seats is the exception and it matters: their
   * allocation is a promise to them, granted whenever `open_seats > 0`
   * regardless of the extras pool (§7.4), so turning them away here would break
   * a promise the engine would have kept. `extras_pool` reaching zero only means
   * there is nothing left *for extras*.
   */
  const playerOwedBase = registrant.kind === 'PLAYER' && Object.keys(form.limits).length > 0;
  if (indicator?.state === 'FULL' && !playerOwedBase) {
    return <FormFull title={form.title} />;
  }

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-3">
        <h1 className="text-2xl font-semibold tracking-tight text-balance">{form.title}</h1>
        {form.description ? (
          <div className="text-sm text-muted-foreground">
            <RichText markdown={form.description} />
          </div>
        ) : null}
      </header>

      <RegistrationForm
        slug={form.slug}
        schema={form.schema}
        schemaVersion={form.schemaVersion}
        limits={form.limits}
        copy={form.copy}
        indicator={indicator}
        token={token}
        registrant={
          registrant.kind === 'PLAYER'
            ? { fullName: registrant.fullName, email: registrant.email }
            : null
        }
        /**
         * A token that did not resolve is reported on the form rather than as
         * its own screen: the public form below it is still perfectly usable,
         * and turning a mistyped player link into a dead end would send someone
         * away from a form they could have filled in.
         */
        unknownToken={registrant.kind === 'UNKNOWN_TOKEN'}
      />
    </div>
  );
}
