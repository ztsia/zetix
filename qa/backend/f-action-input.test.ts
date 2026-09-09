/**
 * QA phase 4 — hostile input at module `F`'s Server Action boundary (AC-55).
 *
 * `zod` is supposed to be the boundary: a malformed field returns a structured
 * error, never an unhandled throw. Two of these actions call `JSON.parse()` on
 * a form field *before* the `safeParse`, and outside the `try`.
 */
import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';

vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`redirect:${to}`);
  },
  notFound: () => {
    throw new Error('notFound');
  },
}));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

const admin = { id: randomUUID(), role: 'ADMIN' as const, email: 'a@test', displayName: 'Admin' };
vi.mock('@/lib/auth/session', () => ({
  getSessionUser: async () => admin,
  recordLogin: async () => {},
}));

vi.mock('@/lib/email/queue', () => ({ queueBlast: async () => ({ queued: 0, unknownTokens: [] }) }));
vi.mock('@/lib/email/defaults', () => ({ seedDefaultTemplates: async () => ({ inserted: 0 }) }));
vi.mock('@/lib/email/mutations', () => ({
  confirmBatch: async () => ({ queued: 0 }),
  discardDrafts: async () => ({ discarded: 0 }),
  editMessage: async () => ({ updated: true }),
  editTemplateAndRerender: async () => ({ rerendered: 0, preserved: 0 }),
  markDelivered: async () => ({ marked: 0 }),
  clearDeliveryForResend: async () => ({ cleared: 0 }),
  ReasonRequiredError: class extends Error {},
}));

const actions = await import('@/app/(admin)/admin/concerts/[concertId]/email/actions');

function form(entries: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(entries)) data.set(key, value);
  return data;
}

describe('AC-55 the zod boundary on the delivery actions', () => {
  const hostile = [
    ['not json at all', 'oops'],
    ['a bare word', 'undefined'],
    ['a truncated array', '[1,'],
    ['SQL metacharacters', "1'; drop table attendees --"],
    ['a very long string', 'x'.repeat(20_000)],
    ['a path traversal', '../../../etc/passwd'],
  ] as const;

  for (const [label, value] of hostile) {
    it(`markDeliveredAction returns a structured error for ${label}`, async () => {
      const result = await actions
        .markDeliveredAction(form({ attendeeIds: value, reason: 'because' }))
        .then(
          (r) => ({ threw: false as const, r }),
          (e: unknown) => ({ threw: true as const, e: String(e) }),
        );
      if (result.threw) console.error(`markDelivered/${label}:`, result.e);
      expect({ label, threw: result.threw }).toEqual({ label, threw: false });
    });

    it(`resendTicketsAction returns a structured error for ${label}`, async () => {
      const result = await actions
        .resendTicketsAction(
          form({ attendeeIds: value, reason: 'because', confirmation: 'RESEND TICKETS' }),
        )
        .then(
          (r) => ({ threw: false as const, r }),
          (e: unknown) => ({ threw: true as const, e: String(e) }),
        );
      expect({ label, threw: result.threw }).toEqual({ label, threw: false });
    });
  }

  it('a well-formed but out-of-range id is refused', async () => {
    const result = await actions.markDeliveredAction(
      form({ attendeeIds: '[-1]', reason: 'because' }),
    );
    expect(result.error).toBeTruthy();
  });

  it('an empty selection is refused', async () => {
    const result = await actions.markDeliveredAction(form({ attendeeIds: '[]', reason: 'because' }));
    expect(result.error).toContain('Select at least one');
  });
});
