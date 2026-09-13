import { NextResponse } from 'next/server';
import { loadFormBySlug } from '@/lib/forms/load';
import { throttleFormRequest } from '@/lib/forms/throttle';

/**
 * `GET /api/forms/{slug}` — everything the renderer needs for one form, and the
 * throttled boundary in front of it (spec/v2.md §8.2, §8.3, `ref.md` §7).
 *
 * **The HTTP face of `loadFormBySlug`, not a second implementation of it.** A
 * server-rendered page calls the function directly and never comes through
 * here; this exists for the consumers that cannot — `M`'s edit screen
 * re-reading a form after a schema change, and anything client-side that needs
 * the caps and the resolved copy without hardcoding either.
 *
 * It is also where the per-IP throttle is demonstrably a `429` rather than a
 * rendered apology: a page in the App Router cannot set that status, and
 * `Retry-After` is the whole point of returning it.
 *
 * **No authentication, by design.** Possession of the slug is not a credential
 * — an open public form is open — so what this returns is only ever a form's
 * *questions*, never a response, never an attendee, never a count of seats.
 * Anything that needs a token or names a person is `M`'s and does not belong on
 * an unauthenticated route.
 */
export const runtime = 'nodejs';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  /**
   * First, before the lookup.
   *
   * The lookup is the thing being protected: a slug is guessable, and a route
   * that reads the database before deciding whether to answer is a route an
   * attacker can use to enumerate slugs at whatever rate the database will bear.
   */
  const throttled = await throttleFormRequest(request.headers);
  if (throttled) return throttled;

  const { slug } = await params;
  const form = await loadFormBySlug(slug);

  const noStore = { 'Cache-Control': 'no-store' };

  switch (form.state) {
    case 'NOT_FOUND':
      return NextResponse.json({ error: 'Not found' }, { status: 404, headers: noStore });

    case 'CLOSED':
      return NextResponse.json(
        {
          state: 'CLOSED',
          title: form.title,
          opensAt: form.opensAt?.toISOString() ?? null,
          closesAt: form.closesAt?.toISOString() ?? null,
        },
        { status: 200, headers: noStore },
      );

    case 'NOT_CONFIGURED':
      /**
       * `503`, not `404` and not `500`. The form exists and nothing is broken —
       * somebody has not finished entering this concert, and it will work when
       * they have. `missing` is deliberately **not** in the body: it names
       * internal setting keys, and this route is public.
       */
      return NextResponse.json(
        { state: 'NOT_CONFIGURED', title: form.title, error: 'This form is not open yet.' },
        { status: 503, headers: noStore },
      );

    case 'OPEN':
      return NextResponse.json(
        {
          state: 'OPEN',
          slug: form.slug,
          kind: form.kind,
          title: form.title,
          description: form.description,
          schema: form.schema,
          limits: form.limits,
          copy: form.copy,
        },
        { status: 200, headers: noStore },
      );
  }
}
