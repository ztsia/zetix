import { describe, expect, it, vi } from 'vitest';

/**
 * The bulk-selection cap in `notes/actions.ts` is `z.array(...).max(500)`, and
 * the question this asks is what an admin is *told* when they exceed it.
 */
vi.mock('next/navigation', () => ({
  redirect: (to: string) => { throw new Error(`redirect:${to}`); },
  notFound: () => { throw new Error('notFound'); },
}));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('@/lib/audit', () => ({ writeAuditLog: async () => {} }));

/** The seeded QA admin, so `moderated_by`'s foreign key is satisfiable. */
const admin = { id: '11111111-1111-4111-8111-111111111111', role: 'ADMIN' as const, email: 'committee@example.test', displayName: 'Committee' };
vi.mock('@/lib/auth/session', () => ({
  getSessionUser: async () => admin,
  recordLogin: async () => {},
}));

const actions = await import('@/app/(admin)/admin/concerts/[concertId]/notes/actions');

describe('the bulk cap', () => {
  it('reports "Select at least one note." when 501 notes are selected', async () => {
    const ids = Array.from({ length: 501 }, (_, i) => i + 1);
    const result = await actions.moderateNotesAction(1, ids, 'APPROVED');
    // eslint-disable-next-line no-console
    console.log('501 ids ->', JSON.stringify(result));
    expect(result.error).toBe('Select at least one note.');
  });

  it('accepts 500', async () => {
    const ids = Array.from({ length: 500 }, (_, i) => i + 1);
    const result = await actions.moderateNotesAction(1, ids, 'APPROVED');
    expect(result.error).toBeNull();
  });
});
