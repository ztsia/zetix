import { DoubleSend } from './double-send';
import { LockRace } from './lock-race';
import { Sql } from './sql';

/** `drizzle/0200_v3_schema_delta.sql`, inside `claim_seats()`, verbatim. */
const LOCK = `-- Serialise per hall. Everything below reads counts and then writes rows;
-- without this lock two callers read the same figures and both write.
perform 1
   from shows s
   join show_segments g on g.show_id = s.id
  where g.id = p_segment_id
    for update of s;`;

/** The same migration, with the index under the name it ends up with. */
const OUTBOX = `create unique index outbox_no_duplicate_pending
    on email_outbox (registration_id, purpose)
 where status in ('DRAFT', 'QUEUED', 'SENDING')
   and purpose <> 'REPLY';
-- and the queueing insert ends: on conflict do nothing`;

/**
 * Programme notes: the engineering, the way a concert programme explains the music. Two of the
 * three things that must not go wrong on the night, each one runnable, with the SQL that makes it
 * so. The third is the door, next.
 */
export function Notes() {
  return (
    <section id="notes" className="zx-notes" data-cue="up" aria-labelledby="zx-notes-title">
      <div className="zx-wrap">
        <header className="zx-section-head">
          <h2 id="zx-notes-title" className="zx-h2">
            Programme notes
          </h2>
          <p className="zx-section-head__lead">
            On the night, three things must not go wrong. Two are settled in Postgres, here. The third is at
            the door.
          </p>
        </header>

        <div className="zx-notes__grid">
          <article className="zx-note zx-note--race" aria-labelledby="zx-note-race">
            <h3 id="zx-note-race" className="zx-h3">
              Overselling is impossible.
            </h3>
            <p className="zx-note__body">
              Two guests ask for the last seat at the same moment. The first request takes a lock on the hall;
              the second waits, then counts again.
            </p>
            <LockRace />
            <Sql code={LOCK} source="drizzle/0200_v3_schema_delta.sql, in claim_seats()" />
          </article>

          <article className="zx-note zx-note--send" aria-labelledby="zx-note-send">
            <h3 id="zx-note-send" className="zx-h3">
              Sending twice is harmless.
            </h3>
            <p className="zx-note__body">
              Tickets go out through an outbox. A partial unique index allows one pending message per party,
              so a second press changes nothing.
            </p>
            <DoubleSend />
            <Sql code={OUTBOX} source="drizzle/0200_v3_schema_delta.sql" />
          </article>
        </div>
      </div>
    </section>
  );
}
