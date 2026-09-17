import { describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';

/**
 * §13.4: "Only an explicit admin action puts any note on the public wall, and
 * only when the concert has the wall enabled." Does the publish action read
 * `portal.public_wall_enabled` at all?
 */
vi.mock('next/navigation', () => ({
  redirect: (to: string) => { throw new Error(`redirect:${to}`); },
  notFound: () => { throw new Error('notFound'); },
}));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('@/lib/audit', () => ({ writeAuditLog: async () => {} }));

const admin = {
  id: '11111111-1111-4111-8111-111111111111',
  role: 'ADMIN' as const, email: 'committee@example.test', displayName: 'Committee',
};
vi.mock('@/lib/auth/session', () => ({
  getSessionUser: async () => admin,
  recordLogin: async () => {},
}));

const sql = postgres(process.env.DATABASE_URL!, { prepare: false, max: 2 });
const actions = await import('@/app/(admin)/admin/concerts/[concertId]/notes/actions');

describe('publishing while the concert wall is disabled', () => {
  it('records what the action does', async () => {
    await sql`update system_settings set value = 'false'::jsonb
               where key = 'portal.public_wall_enabled'`;
    const [note] = await sql<{ id: string }[]>`
      select id from portal_notes
       where concert_id = 1 and to_player_id is null and moderation_status = 'APPROVED'
       limit 1`;
    await sql`update portal_notes set wall_status = 'NOT_PUBLISHED' where id = ${Number(note.id)}`;

    const result = await actions.setNotesOnWallAction(1, [Number(note.id)], true);
    const [after] = await sql<{ wall_status: string }[]>`
      select wall_status from portal_notes where id = ${Number(note.id)}`;
    // eslint-disable-next-line no-console
    console.log('wall disabled -> result:', JSON.stringify(result), '| wall_status:', after.wall_status);

    await sql`update system_settings set value = 'true'::jsonb
               where key = 'portal.public_wall_enabled'`;
    await sql`update portal_notes set wall_status = 'NOT_PUBLISHED' where id = ${Number(note.id)}`;
    await sql.end();

    // §13.4 reads as: this should not have published.
    expect(after.wall_status).toBe('NOT_PUBLISHED');
  });
});
