import { writeFileSync, readFileSync } from 'node:fs';
import { it } from 'vitest';
import { resetDb, sql } from '../../tests/helpers/db';
import { createConcert, createSegment, createShow } from '../../tests/helpers/fixtures';
import { startCommand } from '@/lib/commands/runner';
import { getCommand } from '@/lib/commands/registry';
import { seedDefaultTemplates } from '@/lib/email/defaults';
import { createRegistration } from '@/lib/registrations/mutations';

/**
 * QA module T, AC-16: two OS processes run Send tickets over the same parties
 * at once. Driven by qa/support/t-race.sh; RACE_ROLE picks the part.
 */
const STATE = process.env.RACE_STATE!;
const role = process.env.RACE_ROLE!;
const N = 20;

it(`race role ${role}`, async () => {
  if (role === 'setup') {
    await resetDb();
    await seedDefaultTemplates();
    const concertId = await createConcert('Race');
    const showId = await createShow(concertId, 500);
    const seg = await createSegment(showId, { audienceMode: 'PUBLIC', capacity: 200, extrasPolicy: 'AUTO_FCFS', allowPartialGrant: false, name: 'Pub' });
    await sql`insert into ticket_templates (concert_id, name, version, background_kind, page_width_pt, page_height_pt, layout, is_default)
      values (${concertId}, 'D', 1, 'NONE', 595, 280, '{"canvas":{"width_pt":595,"height_pt":280,"dpi":300},"elements":[]}', true)`;
    const ids: number[] = [];
    for (let i = 0; i < N; i++) {
      ids.push((await createRegistration({ segmentId: seg, contactName: `P${i}`, contactEmail: `p${i}@example.test`,
        seats: [{ fullName: `P${i} a`, allocationType: 'EXTRA' }, { fullName: `P${i} b`, allocationType: 'EXTRA' }] })).registrationId);
    }
    writeFileSync(STATE, JSON.stringify({ concertId, seg, ids }));
    return;
  }
  const s = JSON.parse(readFileSync(STATE, 'utf8'));
  const params = process.env.RACE_TEMPLATES === 'differ' && role === 'b' ? { templates: { [s.seg]: 'player_confirmation' } } : {};
  const report = await startCommand(getCommand('delivery.send_tickets')!, { concertId: s.concertId, selection: { filter: {}, excludedIds: [] }, params },
    { actorId: null, deadline: Date.now() + 120_000 });
  console.error(`RACE ${role} status=${report.status} done=${report.done} skipped=${report.skipped} failed=${report.failed} errors=${JSON.stringify([...new Set(report.items.filter((i) => i.error).map((i) => i.error))])}`);
}, 180_000);
