import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, sql } from '../helpers/db';
import { createConcert, createSegment, createShow, setSystemSetting } from '../helpers/fixtures';

// The MX lookup is a network call; the verdict is the address module's own
// business and tested there. Here only "was it asked, and was the answer kept".
vi.mock('@/lib/email/address', () => ({
  addressIssue: async (email: string) => (email.includes('..') ? 'This is not a valid email address.' : null),
}));

import { previewCommand } from '@/lib/commands/runner';
import { getCommand } from '@/lib/commands/registry';
import { changeContactEmail } from '@/lib/delivery/address';
import { checkUncheckedAddresses, renderEmailPreview, selectedParties, wizardSetup } from '@/lib/delivery/wizard';
import { getDb } from '@/db/client';
import { seedDefaultTemplates } from '@/lib/email/defaults';
import { createRegistration } from '@/lib/registrations/mutations';

/**
 * The send wizard's server half — spec/v3.md §24.1, §24.6: the Who step
 * checks never-checked addresses before the preview, each segment's defaults
 * are the command's own, and the email preview reads as the recipient would.
 */

let concertId: number;
let publicSeg: number;
let playerSeg: number;

async function party(segmentId: number, email: string | null, names = ['Guest One']) {
  const { registrationId } = await createRegistration({
    segmentId,
    contactName: 'Party',
    contactEmail: email,
    seats: names.map((fullName) => ({ fullName, allocationType: 'EXTRA' as const })),
  });
  return registrationId;
}

beforeEach(async () => {
  await resetDb();
  await seedDefaultTemplates();
  concertId = await createConcert('Wizard');
  const showId = await createShow(concertId, 100);
  publicSeg = await createSegment(showId, { audienceMode: 'PUBLIC', capacity: 40, extrasPolicy: 'AUTO_FCFS', allowPartialGrant: false, name: 'Public' });
  playerSeg = await createSegment(showId, { audienceMode: 'PLAYER_INVITED', capacity: 40, extrasPolicy: 'AUTO_FCFS', allowPartialGrant: false, name: 'Players' });
  await sql`
    insert into ticket_templates (concert_id, name, version, background_kind, page_width_pt, page_height_pt, layout, is_default)
    values (${concertId}, 'Default', 1, 'NONE', 595, 280, '{"canvas":{"width_pt":595,"height_pt":280,"dpi":300},"elements":[]}', true)`;
  await setSystemSetting('admin.typed_confirm_above', 20);
});

describe('the Who step’s address checks (§24.6)', () => {
  it('checks only never-checked addresses, keeps the verdict, and the preview then skips the flagged', async () => {
    const good = await party(publicSeg, 'good@example.test');
    const bad = await party(publicSeg, 'bad..dot@example.test');
    const checkedBefore = await party(publicSeg, 'old..typo@example.test');
    await sql`update registrations set email_checked_at = now() where id = ${checkedBefore}`;

    const summary = await checkUncheckedAddresses(concertId, [good, bad, checkedBefore], {
      budgetMs: 5_000,
      concurrency: 2,
      actorId: null,
    });
    expect(summary).toEqual({ checked: 2, flagged: 1, left: 0 });

    const rows = await sql<{ id: string; email_issue: string | null; email_checked_at: Date | null }[]>`
      select id, email_issue, email_checked_at from registrations order by id`;
    expect(rows.find((r) => Number(r.id) === bad)?.email_issue).toMatch(/not a valid/);
    expect(rows.find((r) => Number(r.id) === good)?.email_issue).toBeNull();
    // Checked before: left as the admin last saw it.
    expect(rows.find((r) => Number(r.id) === checkedBefore)?.email_issue).toBeNull();

    const p = await previewCommand(getCommand('delivery.send_tickets')!, { concertId, selection: { ids: [good, bad] }, params: {} }, null);
    expect(p.runnable).toBe(1);
    expect(p.rows.find((r) => r.id === bad)?.skip).toMatch(/Suspicious address/);
  });
});

describe('wizardSetup', () => {
  it('names each segment’s default design and template, and the longest name to preview with', async () => {
    const a = await party(publicSeg, 'a@example.test', ['Jo', 'Wellington Mainwaring-Fitzgerald']);
    const b = await party(playerSeg, 'b@example.test', ['Sam']);
    await sql`insert into segment_message_defaults (segment_id, purpose, template_key)
              values (${playerSeg}, 'TICKETS', 'public_ticket')`;

    const ids = await selectedParties(getDb(), concertId, { filter: {}, excludedIds: [] });
    expect(ids.sort()).toEqual([a, b].sort());
    const setup = await wizardSetup(concertId, ids);

    const pub = setup.segments.find((s) => s.id === publicSeg)!;
    const ply = setup.segments.find((s) => s.id === playerSeg)!;
    expect(pub.defaultTemplate).toBe('public_ticket');
    // The segment's stored default wins over the audience's (§24.2).
    expect(ply.defaultTemplate).toBe('public_ticket');
    expect(pub.longest?.name).toBe('Wellington Mainwaring-Fitzgerald');
    expect(pub.defaultDesignId).toBe(setup.designs[0].id);
    expect(setup.templates.map((t) => t.key).sort()).toEqual(['player_confirmation', 'public_ticket']);
  });

  it('never reaches another concert’s parties from hand-ticked ids', async () => {
    const other = await createConcert('Other');
    const otherShow = await createShow(other, 10);
    const otherSeg = await createSegment(otherShow, { audienceMode: 'PUBLIC', capacity: 5, extrasPolicy: 'AUTO_FCFS', allowPartialGrant: false });
    const stranger = await party(otherSeg, 'x@example.test');
    expect(await selectedParties(getDb(), concertId, { ids: [stranger] })).toEqual([]);
  });
});

describe('renderEmailPreview', () => {
  it('renders this send’s wording as the recipient reads it, and says how many links come later', async () => {
    const id = await party(publicSeg, 'a@example.test', ['Ann Lee', 'Bo Tan']);
    const preview = await renderEmailPreview(concertId, id, 'public_ticket', {
      subject: 'For {{ registration.contact_name }}',
      bodyMd: 'Hello {{ nonsense }}',
    });
    expect(preview?.subject).toBe('For Party');
    expect(preview?.unknown).toEqual(['nonsense']);
    expect(preview?.unissued).toBe(2);
    expect(preview?.toEmail).toBe('a@example.test');
  });

  it('refuses a party from another concert', async () => {
    const other = await createConcert('Other');
    const otherShow = await createShow(other, 10);
    const otherSeg = await createSegment(otherShow, { audienceMode: 'PUBLIC', capacity: 5, extrasPolicy: 'AUTO_FCFS', allowPartialGrant: false });
    const stranger = await party(otherSeg, 'x@example.test');
    expect(await renderEmailPreview(concertId, stranger, 'public_ticket', null)).toBeNull();
  });
});

describe('changeContactEmail (fix address)', () => {
  it('changes only the address, re-addresses what is waiting, and keeps the verdict', async () => {
    const id = await party(publicSeg, 'old@example.test');
    await sql`update registrations set round_label = 'Round 2' where id = ${id}`;
    await sql`insert into email_outbox (registration_id, purpose, template_key, to_email, subject, body_md, status)
              values (${id}, 'REMINDER', 'reminder', 'old@example.test', 's', 'b', 'QUEUED')`;

    const result = await changeContactEmail(concertId, id, 'new..dot@example.test', null);
    expect(result).toEqual({ issue: 'This is not a valid email address.', readdressed: 1 });
    const [row] = await sql<{ contact_email: string; round_label: string; email_issue: string }[]>`
      select contact_email, round_label, email_issue from registrations where id = ${id}`;
    expect(row).toMatchObject({ contact_email: 'new..dot@example.test', round_label: 'Round 2' });
    expect(row.email_issue).toMatch(/not a valid/);
    const [queued] = await sql<{ to_email: string }[]>`select to_email from email_outbox where registration_id = ${id}`;
    expect(queued.to_email).toBe('new..dot@example.test');
  });
});
