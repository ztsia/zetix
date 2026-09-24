import 'server-only';
import { NextResponse } from 'next/server';
import { clientIp, consumeRateLimit, formBucket, type ThrottleContext } from '@/lib/auth/rate-limit';

/**
 * The throttle every form surface passes through (spec/v2.md §8.3, `ref.md` §7).
 *
 * `K` owns this because `K` owns that boundary. The counting itself lives in
 * `src/lib/auth/rate-limit.ts` — one module for "rate limiting", not two
 * (`docs/modules-v2.md` §3) — and this is the thin part that turns a verdict
 * into an HTTP response.
 *
 * **In the handler, never in `src/proxy.ts`.** The proxy runs on every request
 * including prefetches and never touches the database (`modules.md` §5.2.1);
 * moving a `select` into it would put a database round trip in front of every
 * static asset and make a database blip look like a total outage.
 */

/**
 * Consume one request against the caller's IP.
 *
 * Returns `null` when the request may proceed, or the `429` to return when it
 * may not. Written this way rather than as a wrapper so it can guard a Route
 * Handler, a Server Action and a page's data load without three shapes.
 *
 * **Call it before anything else in the handler.** A throttle that runs after
 * the lookup has already let the caller use the route to probe for slugs, which
 * is the enumeration this exists to stop.
 */
export async function throttleFormRequest(
  headers: Headers,
  ctx: ThrottleContext = {},
): Promise<NextResponse | null> {
  const verdict = await consumeRateLimit(formBucket(clientIp(headers)), ctx);
  if (verdict.allowed) return null;
  return tooManyRequests(verdict.retryAfterSeconds);
}

/**
 * `429`, with the two headers a client can act on.
 *
 * `Retry-After` is the real remaining window rather than a flat minute, so a
 * well-behaved client waits exactly as long as it has to. The body says the
 * same thing in a sentence, because the caller here is usually a browser
 * showing it to a person.
 */
export function tooManyRequests(retryAfterSeconds: number): NextResponse {
  return NextResponse.json(
    {
      error: 'Too many requests. Please wait a moment and try again.',
      retryAfterSeconds,
    },
    {
      status: 429,
      headers: {
        'Retry-After': String(retryAfterSeconds),
        /**
         * Never cached, at any layer. A cached `429` would lock out everyone
         * behind the same shared cache, and a cached `200` would serve one
         * caller's form to the next.
         */
        'Cache-Control': 'no-store',
      },
    },
  );
}
