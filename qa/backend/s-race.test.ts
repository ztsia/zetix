import { writeFileSync, readFileSync } from 'node:fs';
import { it } from 'vitest';
import { resetDb, sql } from '../../tests/helpers/db';
import { createConcert, createSegment, createShow } from '../../tests/helpers/fixtures';
import { startCommand } from '@/lib/commands/runner';
import { getCommand } from '@/lib/commands/registry';
import { createRegistration } from '@/lib/registrations/mutations';

/**
 * QA module S, AC-41: two OS processes run a seat-granting command for the last
 * seat at once. Driven by qa/support/s-race.sh; RACE_ROLE picks the part.
 */
const STATE = process.env.RACE_STATE!;
const role = process.env.RACE_ROLE!;
const command = process.env.RACE_COMMAND ?? 'audience.confirm_seats';

it(`race role ${role}`, async () => {
  if (role === 'setup') {
    await resetDb();
    const concertId = await createConcert('Race');
    const showId = await createShow(concertId, 100);
    const seg = await createSegment(showId, { audienceMode: 'PLAYER_INVITED', capacity: 1, extrasPolicy: 'REVIEW', allowPartialGrant: false, name: 'One' });
    const mk = async (name: string, type: 'COMP' | 'EXTRA') =>
      (await createRegistration({ segmentId: seg, contactName: name, contactEmail: `${name}@x.test`, seats: [{ fullName: name, allocationType: type }] })).registrationId;
    const holder = await mk('holder', 'COMP');
    const a = await mk('a', command === 'audience.grant_extras' ? 'EXTRA' : 'COMP');
    const b = await mk('b', command === 'audience.grant_extras' ? 'EXTRA' : 'COMP');
    await sql`update attendees set status = 'CANCELLED' where registration_id = ${holder}`;
    writeFileSync(STATE, JSON.stringify({ concertId, showId, seg, a, b }));
    return;
  }
  const s = JSON.parse(readFileSync(STATE, 'utf8'));
  const id = role === 'a' ? s.a : s.b;
  const report = await startCommand(getCommand(command)!, { concertId: s.concertId, selection: { ids: [id] }, params: {} }, { actorId: null, deadline: Date.now() + 60_000 });
  console.error(`RACE ${role} done=${report.done} skipped=${report.skipped} failed=${report.failed} ${JSON.stringify(report.items[0])}`);
});
