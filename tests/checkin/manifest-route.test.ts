import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `/api/checkin/manifest` — **the security boundary that matters**
 * (spec/checkin.md §12.3, decision 20).
 *
 * The response is every attendee's name for a show. An operator who could ask
 * for any `showId` could download the roster of every show, which defeats the
 * entire point of scoping operators to assignments.
 *
 * Two layers guard it and these tests cover the first one, the handler. The
 * second — `manifest_for_show()` refusing on its own, from the JWT subject — is
 * `tests/auth/manifest-rpc.test.ts`, and the two are deliberately separate:
 * a test that mocked its way past the handler and still expected data would
 * quietly prove nothing about either.
 *
 * `tests/auth/manifest-call-site.test.ts` is the third piece, and the one that
 * catches the failure decision 20b actually fears: a route that satisfies every
 * assertion here while reading the roster over Drizzle and having no second
 * layer at all.
 */
const getSessionUser = vi.fn();
const canAccessShow = vi.fn();
const rpc = vi.fn();

vi.mock('@/lib/auth/session', () => ({ getSessionUser: () => getSessionUser() }));
vi.mock('@/lib/auth/show-access', () => ({
  canAccessShow: (...args: unknown[]) => canAccessShow(...args),
}));
vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: async () => ({ rpc: (...args: unknown[]) => rpc(...args) }),
}));

const { GET } = await import('@/app/api/checkin/manifest/route');

const operator = {
  id: 'o1',
  email: 'wei@operators.invalid',
  displayName: 'Wei',
  role: 'OPERATOR' as const,
};
const admin = { id: 'a1', email: 'admin@x', displayName: 'Committee', role: 'ADMIN' as const };

const row = {
  attendee_id: '31',
  qr_token_sha256: 'a'.repeat(64),
  has_ticket: true,
  ticket_code: 'ORC-7K4Q',
  name: 'Alice Tan',
  name_source: 'PROVIDED',
  player_name: 'Wei Ling',
  status: 'CONFIRMED',
  registration_id: 7,
  party_size: 4,
  segment_name: 'Player guests',
  checked_in_at: '2026-09-19T19:42:00+08:00',
  checked_in_by: 'Bob',
};

/** A seat confirmed but not yet ticketed: no token, so no digest. */
const unticketed = {
  ...row,
  attendee_id: '32',
  qr_token_sha256: null,
  has_ticket: false,
  ticket_code: null,
  name: 'Guest of Alice Tan',
  name_source: 'PLACEHOLDER',
  checked_in_at: null,
  checked_in_by: null,
};

const get = (query = '?showId=1') =>
  GET(new Request(`http://localhost/api/checkin/manifest${query}`));

beforeEach(() => {
  getSessionUser.mockReset();
  canAccessShow.mockReset();
  rpc.mockReset();
  rpc.mockResolvedValue({ data: [row], error: null });
});

describe('who may read a roster', () => {
  it('refuses an anonymous caller with 401', async () => {
    getSessionUser.mockResolvedValue(null);
    expect((await get()).status).toBe(401);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('refuses an operator who is not rostered on the show', async () => {
    getSessionUser.mockResolvedValue(operator);
    canAccessShow.mockResolvedValue(false);
    expect((await get('?showId=2')).status).toBe(404);
  });

  it('returns 404 and not 403, so probing cannot tell "not yours" from "not there"', async () => {
    // modules.md §5.2.1. A 403 answers the question a 404 refuses: it confirms
    // the show exists. Walking the id space would then map every show in the
    // system from an account rostered on none of them.
    getSessionUser.mockResolvedValue(operator);
    canAccessShow.mockResolvedValue(false);
    const response = await get('?showId=999');
    expect(response.status).toBe(404);
    expect(response.status).not.toBe(403);
  });

  it('does not call the database at all for a caller it has already refused', async () => {
    // "Before returning a single byte" (§12.3). A handler that fetched first and
    // filtered second would put the whole roster in this process's memory for a
    // request it had already decided to refuse.
    getSessionUser.mockResolvedValue(operator);
    canAccessShow.mockResolvedValue(false);
    await get();
    expect(rpc).not.toHaveBeenCalled();
  });

  it('serves an operator who is rostered', async () => {
    getSessionUser.mockResolvedValue(operator);
    canAccessShow.mockResolvedValue(true);
    const response = await get();
    expect(response.status).toBe(200);
    expect(canAccessShow).toHaveBeenCalledWith(operator, 1);
  });

  it('serves an ADMIN, who is allowed at any door', async () => {
    getSessionUser.mockResolvedValue(admin);
    canAccessShow.mockResolvedValue(true);
    expect((await get()).status).toBe(200);
  });
});

describe('how it reads the roster', () => {
  beforeEach(() => {
    getSessionUser.mockResolvedValue(operator);
    canAccessShow.mockResolvedValue(true);
  });

  it('goes through manifest_for_show(), which is the second layer', async () => {
    await get('?showId=3');
    expect(rpc).toHaveBeenCalledWith('manifest_for_show', { p_show_id: 3 });
  });

  it('returns the roster fields of spec/v3.md §32.2, camel-cased for the client', async () => {
    const body = await (await get()).json();
    expect(body.attendees).toEqual([
      {
        attendeeId: 31,
        qrTokenSha256: 'a'.repeat(64),
        hasTicket: true,
        ticketCode: 'ORC-7K4Q',
        name: 'Alice Tan',
        nameSource: 'PROVIDED',
        playerName: 'Wei Ling',
        status: 'CONFIRMED',
        registrationId: 7,
        partySize: 4,
        segmentName: 'Player guests',
        checkedInAt: '2026-09-19T11:42:00.000Z',
        checkedInBy: 'Bob',
      },
    ]);
  });

  it('keeps a seat with no ticket addressable, by its attendee id', async () => {
    // The P0 behind §32.2: a null digest was the only key such a seat had.
    rpc.mockResolvedValue({ data: [row, unticketed], error: null });
    const body = await (await get()).json();
    expect(body.attendees.map((a: { attendeeId: number }) => a.attendeeId)).toEqual([31, 32]);
    expect(body.attendees[1]).toMatchObject({ hasTicket: false, qrTokenSha256: null });
  });

  it('stamps fetchedAt on the server, not the phone', async () => {
    // The manifest expires at show start + checkin.manifest_ttl_hours. A device
    // with a wrong clock is most of why a TTL fails at a door, so the phone does
    // not get to decide when its own copy went stale.
    const body = await (await get()).json();
    expect(Date.parse(body.fetchedAt)).not.toBeNaN();
  });

  it('never lets the roster be cached anywhere but the phone', async () => {
    expect((await get()).headers.get('Cache-Control')).toBe('no-store');
  });

  it('reports a fault as a fault, rather than as an empty roster', async () => {
    // The function returns zero rows for an authorization miss and never errors
    // (decision 20b), so an error here is real. An empty list would read at the
    // door as "nobody is coming", and the door would act on it.
    rpc.mockResolvedValue({ data: null, error: { message: 'boom' } });
    expect((await get()).status).toBe(502);
  });

  it('rejects a non-numeric showId before doing any work', async () => {
    expect((await get('?showId=../../etc')).status).toBe(400);
    expect((await get('')).status).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
  });
});
