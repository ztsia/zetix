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

/**
 * **Updated after the finding it records was fixed.** As written by the QA
 * pass this file pinned the defect: a selection of 501 was refused with
 * "Select at least one note.", which is the opposite of what had happened.
 *
 * Both halves of that were wrong. 500 was below what this screen can
 * legitimately select — a concert of several shows holds one note per seat
 * per show and Select-all is one click — and the message named the wrong
 * problem. The cap is now 5000 and the refusal says which limit was hit.
 */
describe('the bulk cap', () => {
  it('accepts 501, which the old cap refused', async () => {
    const ids = Array.from({ length: 501 }, (_, i) => i + 1);
    const result = await actions.moderateNotesAction(1, ids, 'APPROVED');
    expect(result.error).toBeNull();
  });

  it('accepts 500', async () => {
    const ids = Array.from({ length: 500 }, (_, i) => i + 1);
    const result = await actions.moderateNotesAction(1, ids, 'APPROVED');
    expect(result.error).toBeNull();
  });

  it('names the limit when the selection is past it, rather than claiming none', async () => {
    const ids = Array.from({ length: 5001 }, (_, i) => i + 1);
    const result = await actions.moderateNotesAction(1, ids, 'APPROVED');
    expect(result.error).toContain('5000');
    expect(result.error).not.toContain('at least one');
  });
});
