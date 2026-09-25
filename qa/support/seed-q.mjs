/**
 * QA seed for module `Q` — the command runner, the Trash and the Activity log.
 *
 * Starts from module `B`'s seed (one concert, two shows, a 300-seat public
 * segment, 80 players, a handful of parties made through `claim_seats()`), then
 * puts rows in the Trash the way the screens do:
 *
 * - five public parties deleted as `deleteRegistration()` deletes them — seats
 *   first, then the party, at one instant, seats left CONFIRMED;
 * - one seat removed on its own from a live party (`removeAttendee()`);
 * - two players and one unpinned ticket design deleted.
 *
 * `admin.typed_confirm_above` is 2, so deleting three or more rows asks for
 * the typed phrase and one or two do not.
 */
import { execFileSync } from 'node:child_process';
import postgres from 'postgres';

const url = process.env.QA_DATABASE_URL ?? 'postgresql://postgres@localhost:55432/zetix_qa';
const seedB = execFileSync('node', ['qa/support/seed-b.mjs'], { env: process.env, encoding: 'utf8' });
const ids = JSON.parse(seedB.trim().split('\n').at(-1));

const sql = postgres(url, { prepare: false, max: 1 });

await sql`insert into system_settings (key, value) values ('admin.typed_confirm_above', '2'::jsonb)
          on conflict (key) do update set value = excluded.value`;

const [pub] = await sql`select id, show_id from show_segments where audience_mode = 'PUBLIC' order by id limit 1`;

const names = ['Tan Family', 'Lim Household', 'Ong Party', 'Chen Group', 'Wong Guests'];
const deleted = [];
for (const [i, name] of names.entries()) {
  const [r] = await sql`
    insert into registrations (show_id, segment_id, source, contact_name, contact_email, status, requested_at)
    values (${pub.show_id}, ${pub.id}, 'ADMIN', ${name}, ${`party${i + 1}@example.test`}, 'CONFIRMED',
            now() - interval '3 days' + ${i} * interval '1 hour')
    returning id`;
  await sql`select claim_seats(${pub.id}::bigint, ${r.id}::bigint,
    ${JSON.stringify([1, 2].map((n) => ({ full_name: `${name} ${n}`, allocation_type: 'COMP' })))}::text::jsonb, false)`;
  await sql.begin(async (tx) => {
    await tx`update attendees set deleted_at = now() where registration_id = ${r.id} and deleted_at is null`;
    await tx`update registrations set deleted_at = now() where id = ${r.id}`;
  });
  deleted.push(r.id);
}

// A live party with one seat removed on its own.
const [live] = await sql`
  insert into registrations (show_id, segment_id, source, contact_name, contact_email, status, requested_at)
  values (${pub.show_id}, ${pub.id}, 'ADMIN', 'Kaur Family', 'kaur@example.test', 'CONFIRMED', now())
  returning id`;
await sql`select claim_seats(${pub.id}::bigint, ${live.id}::bigint,
  ${JSON.stringify([{ full_name: 'Aman Kaur', allocation_type: 'COMP' }, { full_name: 'Priya Kaur', allocation_type: 'COMP' }])}::text::jsonb, false)`;
const [seat] = await sql`select id from attendees where registration_id = ${live.id} order by id limit 1`;
await sql`update attendees set status = 'CANCELLED', deleted_at = now() where id = ${seat.id}`;

await sql`update players set deleted_at = now()
           where id in (select id from players order by id desc limit 2)`;
await sql`insert into ticket_templates (concert_id, name, version, background_kind, page_width_pt, page_height_pt, layout, deleted_at)
          values (${ids.concertId}, 'Old draft', 1, 'NONE', 595, 280, '{"elements":[]}'::jsonb, now())`;

console.log(JSON.stringify({ ...ids, deletedParties: deleted, liveParty: live.id, removedSeat: seat.id }));
await sql.end();
