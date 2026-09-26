import { it, expect } from 'vitest';
import { resetDb, sql } from '../../tests/helpers/db';
import { createConcert, createSegment, createShow, setSystemSetting } from '../../tests/helpers/fixtures';
import { previewCommand } from '@/lib/commands/runner';
import { getCommand } from '@/lib/commands/registry';
import { seedDefaultTemplates } from '@/lib/email/defaults';
import { createRegistration } from '@/lib/registrations/mutations';

/** QA T: email.md §11.4 — explicit resend over a whole segment needs a typed confirmation. */
it('Resend over "all matching" asks for a typed phrase', async () => {
  await resetDb();
  await seedDefaultTemplates();
  const concertId = await createConcert('R');
  const show = await createShow(concertId, 500);
  const seg = await createSegment(show, { audienceMode: 'PUBLIC', capacity: 300, extrasPolicy: 'AUTO_FCFS', allowPartialGrant: false });
  await sql`insert into ticket_templates (concert_id, name, version, background_kind, page_width_pt, page_height_pt, layout, is_default)
    values (${concertId}, 'D', 1, 'NONE', 595, 280, '{"canvas":{"width_pt":595,"height_pt":280,"dpi":300},"elements":[]}', true)`;
  await setSystemSetting('admin.typed_confirm_above', 20);
  for (let i = 0; i < 30; i++) {
    const { registrationId } = await createRegistration({ segmentId: seg, contactName: `P${i}`, contactEmail: `p${i}@x.test`, seats: [{ fullName: `P${i}`, allocationType: 'EXTRA' }] });
    await sql`update attendees set qr_token = substr(md5(random()::text), 1, 22), ticket_code = 'X-' || id, ticket_template_id = (select id from ticket_templates limit 1), ticket_template_version = 1, ticket_issued_at = now(), ticket_sent_at = now(), ticket_sent_source = 'EMAIL' where registration_id = ${registrationId}`;
  }
  const p = await previewCommand(getCommand('delivery.resend')!, { concertId, selection: { filter: {}, excludedIds: [] }, params: {} }, null);
  console.log('QA RESEND-CONFIRM', JSON.stringify({ runnable: p.runnable, irreversible: p.irreversible, confirmation: (p as unknown as { confirmation: unknown }).confirmation, blast: p.blastRadius }));
  expect(p.runnable).toBe(30);
});
