import { expect, test } from '@playwright/test';
import postgres from 'postgres';

/**
 * FINDING: `loadPublicWall()` bounds the wall at a hardcoded `limit = 100`
 * with no pagination and no "showing 100 of N". Past that, published notes are
 * silently invisible — and their writers are still told "On the public wall".
 *
 * 122 published, approved, unaddressed notes is not a stress figure: this
 * concert seats 400 (`context.md`).
 */
const sql = postgres(
  process.env.QA_DATABASE_URL ?? 'postgresql://postgres@localhost:55432/zetix_qa',
  { prepare: false, max: 2 },
);
const SHOTS = 'qa-artifacts/O-notes-wall/screens';

test.use({ viewport: { width: 375, height: 812 } });

test.afterAll(async () => {
  await sql`delete from portal_notes where display_name like 'Bulk Writer%'`;
  await sql`delete from attendees where ticket_code like 'BLK-%'`;
  await sql`delete from registrations where contact_name = 'Bulk Party'`;
  await sql.end();
});

/**
 * **Rewritten after the defect it found was fixed.** As the QA pass wrote it,
 * this asserted the truncation: 122 published notes, 100 rendered, and the
 * writer of a cut note still told "On the public wall" by their own page.
 *
 * The cap is gone rather than raised — `loadPublicWall` carries no `limit` at
 * all. The bound is structural: one note per attendee, attendees bounded by
 * the hall, and every note here passed an explicit admin action to get
 * published. The seed and the numbers are kept exactly as QA chose them,
 * because 122 in a 400-seat hall is the point.
 */
test('BE-5 the public wall carries every published note, past any round number', async ({ page }) => {
  await sql.begin(async (tx) => {
    await tx`select set_config('zetix.granting', 'on', true)`;
    const [r] = await tx`insert into registrations
      (show_id, segment_id, source, contact_name, contact_email, status, requested_at)
      values (1, 2, 'ADMIN', 'Bulk Party', 'bulk@example.com', 'CONFIRMED', now())
      returning id`;
    await tx`insert into attendees
      (registration_id, show_id, segment_id, full_name, name_source, allocation_type, status,
       ticket_code, qr_token)
      select ${r.id}, 1, 2, 'Bulk ' || g, 'PROVIDED', 'BASE', 'CONFIRMED',
             'BLK-' || g, 'bulktoken' || lpad(g::text, 12, '0')
        from generate_series(1, 120) g`;
  });
  await sql`insert into portal_notes
    (concert_id, show_id, attendee_id, display_name, is_anonymous, body,
     moderation_status, wall_status)
    select 1, 1, a.id, 'Bulk Writer ' || a.id, false, 'Bulk note ' || a.id,
           'APPROVED', 'PUBLISHED'
      from attendees a where a.ticket_code like 'BLK-%'`;

  const [{ n }] = await sql<{ n: number }[]>`
    select count(*)::int as n from portal_notes
     where concert_id = 1 and wall_status = 'PUBLISHED'
       and moderation_status = 'APPROVED' and to_player_id is null`;
  expect(n).toBeGreaterThan(100);

  await page.goto('/t/PublicGuestBBBBBBBBB2x');
  await expect(page.getByText('From the audience')).toBeVisible();
  const html = await page.content();
  const rendered = new Set([...html.matchAll(/Bulk note (\d+)/g)].map((m) => m[1]));
  // eslint-disable-next-line no-console
  console.log(`published in db: ${n}; bulk notes rendered: ${rendered.size}`);
  expect(rendered.size).toBe(120);
  await page.screenshot({ path: `${SHOTS}/BE-5-step-1-wall-complete.png`, fullPage: true });

  /**
   * The seeded note that fell past the old cap is on the page, and its writer
   * is told the truth. Both halves mattered: the badge said "On the public
   * wall" for a note the wall did not carry, which is the failure the writer
   * could see and the orchestra could not.
   */
  expect(html).toContain('The Sibelius was extraordinary tonight.');
  await page.goto('/t/WriterOneFFFFFFFFFF6xx');
  await expect(page.getByText('On the public wall')).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/BE-5b-step-1-badge-is-true.png`, fullPage: true });

  // Every published note should be reachable. It is not, and nothing says so.
  expect(rendered.size + 2).toBe(n);
});
