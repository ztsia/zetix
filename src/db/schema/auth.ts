import { index, pgTable, text } from 'drizzle-orm/pg-core';
import { createdAt, pk } from './columns';

/**
 * `auth_failures` — failed sign-in attempts, for the admin login throttle
 * (spec/admin.md §14.3, spec/README.md §4.2).
 *
 * **This table is an addition to F1's frozen schema.** It is the one thing
 * module `F2` needed that `spec/domain.md` §5.1 does not list, and it is called
 * out in the branch's handoff for exactly that reason.
 *
 * Why a table rather than a counter in memory: the admin code is the entire
 * security boundary for every attendee's name and email, and the spec asks for a
 * hard per-IP limit with a growing lockout. On Vercel each request may land on a
 * different lambda and instances are recycled constantly, so an in-process `Map`
 * would reset the count under exactly the load an attacker generates — a
 * throttle that looks right in a test and is theatre in production.
 *
 * Only **failures** are recorded, and a successful sign-in deletes the bucket.
 * That keeps the table small without a cron: the only rows that exist belong to
 * a credential someone is currently getting wrong.
 *
 * `bucket` is the throttle key, `<surface>:<ip>` — deliberately opaque so the
 * limiter, not the schema, decides what is being throttled.
 */
export const authFailures = pgTable(
  'auth_failures',
  {
    id: pk(),
    bucket: text('bucket').notNull(),
    ...createdAt,
  },
  (t) => [
    /** Every read is "failures in this bucket since T", newest first. */
    index('auth_failures_bucket_created_idx').on(t.bucket, t.createdAt),
  ],
);
