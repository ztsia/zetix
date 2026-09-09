import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getSessionUser } from '@/lib/auth/session';
import { canAccessShow } from '@/lib/auth/show-access';
import { createSupabaseServerClient } from '@/lib/supabase/server';

/**
 * `GET /api/checkin/manifest?showId=` — the offline attendee roster
 * (spec/checkin.md §12.3).
 *
 * **This is the security boundary that matters in the whole system.** It
 * returns every attendee's name for a show. An operator who could request any
 * `showId` could download the full name list of every show, which is exactly
 * what scoping operators to assigned shows exists to prevent (decision 20).
 *
 * Two independent layers, and they are independent on purpose:
 *
 *  1. **`canAccessShow()` — the contract.** F2 owns it and module `H` uses the
 *     same function, so "which shows may this user act on" has one
 *     implementation. Two would drift, and the second would drift silently.
 *  2. **`manifest_for_show()` — what survives a mistake in layer 1.** A
 *     `security definer` function that resolves the caller from the JWT subject
 *     and re-checks `operator_show_assignments` itself, returning zero rows
 *     rather than an error for anyone not rostered
 *     (`drizzle/0003_manifest_rls.sql`, decision 20b).
 *
 * **The roster may not be read here any other way.** `eslint.config.mjs` denies
 * this directory the imports that would let it reach Drizzle, and
 * `tests/auth/manifest-call-site.test.ts` asserts the `.rpc()` call is present —
 * because the one weakness of decision 20b's mechanism is that its coverage is
 * opt-in, and a route that read `attendees` directly would pass every test
 * written about the function while having no second layer at all.
 *
 * `/api` is outside the proxy matcher (modules.md §5.2.1), so a Route Handler is
 * unprotected until it calls `getSessionUser()` itself. It does, first.
 */
export const runtime = 'nodejs';

/**
 * The roster is per-operator, per-show and changes as the door runs. Caching it
 * anywhere but the phone's own IndexedDB would serve one show's names to
 * another show's usher through a shared cache — the exact disclosure the two
 * layers above exist to prevent.
 */
export const dynamic = 'force-dynamic';

const querySchema = z.object({
  showId: z.coerce.number().int().positive(),
});

/** One row of `manifest_for_show()`, as PostgREST returns it. */
/**
 * One row of `manifest_for_show()`, as PostgREST actually returns it.
 *
 * `registration_id` is a `bigint` and arrives as a **string** — JSON has one
 * number type and it cannot hold the full range, so PostgREST plays safe. The
 * scanner groups a party by this value, so a stringly-typed id that the client
 * declares as a number is a comparison waiting to be written the obvious way
 * and silently fail. Coerced once here, at the boundary, rather than trusted.
 */
type ManifestRow = {
  qr_token_sha256: string;
  ticket_code: string | null;
  name: string;
  player_name: string | null;
  status: string;
  registration_id: number | string;
  party_size: number | string;
};

export async function GET(request: Request) {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  }

  const url = new URL(request.url);
  const parsed = querySchema.safeParse({ showId: url.searchParams.get('showId') });
  if (!parsed.success) {
    return NextResponse.json({ error: 'A numeric showId is required' }, { status: 400 });
  }
  const { showId } = parsed.data;

  /**
   * **404, never 403** (modules.md §5.2.1). "You are not rostered on this show"
   * and "this show does not exist" must be indistinguishable to someone walking
   * the id space, and a 403 answers the question a 404 refuses. The scanner's
   * `[showId]` page already makes the same choice for the same reason.
   */
  if (!(await canAccessShow(user, showId))) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc('manifest_for_show', { p_show_id: showId });

  if (error) {
    // The function itself never errors on an authorization miss — it returns
    // zero rows (decision 20b). So an error here is genuinely a fault, and
    // saying so beats an empty roster that the door would read as "nobody is
    // coming" and act on.
    return NextResponse.json({ error: 'Could not load the manifest' }, { status: 502 });
  }

  const rows = (data ?? []) as ManifestRow[];

  return NextResponse.json(
    {
      showId,
      /**
       * Stamped by the server, not the phone. The manifest expires at show start
       * plus `checkin.manifest_ttl_hours` (§12.3), and a device with a wrong
       * clock — which is most of the reason a TTL fails at a door — would
       * otherwise decide its own expiry.
       */
      fetchedAt: new Date().toISOString(),
      attendees: rows.map((row) => ({
        qrTokenSha256: row.qr_token_sha256,
        ticketCode: row.ticket_code,
        name: row.name,
        playerName: row.player_name,
        status: row.status,
        registrationId: Number(row.registration_id),
        partySize: Number(row.party_size),
      })),
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
