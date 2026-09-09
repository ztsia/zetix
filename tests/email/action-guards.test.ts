import { beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';

/**
 * Do module `F`'s Server Actions still **call** `requireAdmin()`?
 *
 * A different claim from "the guard works", and the one an independent QA pass
 * caught `D` and `F2` missing — deleting a guard call left both suites entirely
 * green. A Server Action is its own entry point: the page's guard does not
 * cover it and the proxy never reads a role (modules.md §5.2.1).
 *
 * These actions send email to the audience, clear delivery stamps and rewrite
 * message wording, so an unguarded one is not a small mistake.
 */
class RedirectSignal extends Error {
  constructor(readonly to: string) {
    super(`redirect:${to}`);
  }
}

vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new RedirectSignal(to);
  },
  notFound: () => {
    throw new Error('notFound');
  },
}));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

const sessionUser = vi.fn();
vi.mock('@/lib/auth/session', () => ({
  getSessionUser: () => sessionUser(),
  recordLogin: async () => {},
}));

/** Every mutation is stubbed: this file is about reaching them, not what they do. */
const stub = {
  queueBlast: vi.fn(async () => ({ queued: 1, unknownTokens: [] as string[] })),
  confirmBatch: vi.fn(async () => ({ queued: 1 })),
  discardDrafts: vi.fn(async () => ({ discarded: 1 })),
  editMessage: vi.fn(async () => ({ updated: true })),
  editTemplateAndRerender: vi.fn(async () => ({ rerendered: 1, preserved: 0 })),
  markDelivered: vi.fn(async () => ({ marked: 1 })),
  clearDeliveryForResend: vi.fn(async () => ({ cleared: 1 })),
  seedDefaultTemplates: vi.fn(async () => ({ inserted: 0 })),
};

vi.mock('@/lib/email/queue', () => ({ queueBlast: () => stub.queueBlast() }));
vi.mock('@/lib/email/defaults', () => ({ seedDefaultTemplates: () => stub.seedDefaultTemplates() }));
vi.mock('@/lib/email/mutations', () => ({
  confirmBatch: () => stub.confirmBatch(),
  discardDrafts: () => stub.discardDrafts(),
  editMessage: () => stub.editMessage(),
  editTemplateAndRerender: () => stub.editTemplateAndRerender(),
  markDelivered: () => stub.markDelivered(),
  clearDeliveryForResend: () => stub.clearDeliveryForResend(),
  ReasonRequiredError: class extends Error {},
}));

const actions = await import(
  '@/app/(admin)/admin/concerts/[concertId]/email/actions'
);
const { RESEND_PHRASE } = await import(
  '@/app/(admin)/admin/concerts/[concertId]/email/confirmation'
);

const admin = { id: randomUUID(), role: 'ADMIN' as const, email: 'a@test', displayName: 'Admin' };
const operator = { ...admin, id: randomUUID(), role: 'OPERATOR' as const };

function form(entries: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(entries)) data.set(key, value);
  return data;
}

/** Each action, with input that would otherwise succeed. */
const CALLS: { name: string; run: () => Promise<unknown>; mutation: () => unknown }[] = [
  {
    name: 'prepareBlastAction',
    run: () => actions.prepareBlastAction({ segmentId: 1, templateKey: 'public_ticket' }),
    mutation: () => stub.queueBlast,
  },
  {
    name: 'confirmBatchAction',
    run: () => actions.confirmBatchAction({ segmentId: 1, templateKey: 'public_ticket' }),
    mutation: () => stub.confirmBatch,
  },
  {
    name: 'discardDraftsAction',
    run: () => actions.discardDraftsAction({ segmentId: 1, templateKey: 'public_ticket' }),
    mutation: () => stub.discardDrafts,
  },
  {
    name: 'editMessageAction',
    run: () => actions.editMessageAction(form({ outboxId: '1', subject: 's', bodyMd: 'b' })),
    mutation: () => stub.editMessage,
  },
  {
    name: 'editTemplateAction',
    run: () =>
      actions.editTemplateAction(form({ templateKey: 'public_ticket', subject: 's', bodyMd: 'b' })),
    mutation: () => stub.editTemplateAndRerender,
  },
  {
    name: 'markDeliveredAction',
    run: () => actions.markDeliveredAction(form({ attendeeIds: '[1]', reason: 'handed over' })),
    mutation: () => stub.markDelivered,
  },
  {
    name: 'resendTicketsAction',
    run: () =>
      actions.resendTicketsAction(
        form({ attendeeIds: '[1]', reason: 'deleted it', confirmation: RESEND_PHRASE }),
      ),
    mutation: () => stub.clearDeliveryForResend,
  },
];

beforeEach(() => {
  vi.clearAllMocks();
});

describe.each(CALLS)('$name', ({ run, mutation }) => {
  it('redirects an anonymous caller to the login form and mutates nothing', async () => {
    sessionUser.mockResolvedValue(null);
    await expect(run()).rejects.toThrow(RedirectSignal);
    expect(mutation()).not.toHaveBeenCalled();
  });

  /** An operator is signed in — the case a bare session check waves through. */
  it('turns a signed-in operator away and mutates nothing', async () => {
    sessionUser.mockResolvedValue(operator);
    await expect(run()).rejects.toThrow(RedirectSignal);
    expect(mutation()).not.toHaveBeenCalled();
  });

  it('lets the admin through', async () => {
    sessionUser.mockResolvedValue(admin);
    await run();
    expect(mutation()).toHaveBeenCalled();
  });
});

describe('the typed confirmation on resend', () => {
  /**
   * §11.4: a resend "is never the default path, and never operates on a whole
   * segment at once without a typed confirmation". The check must sit behind
   * the guard *and* in front of the mutation.
   */
  it('refuses the wrong phrase without touching a delivery stamp', async () => {
    sessionUser.mockResolvedValue(admin);

    const result = await actions.resendTicketsAction(
      form({ attendeeIds: '[1]', reason: 'oops', confirmation: 'yes' }),
    );

    expect(result.error).toContain(RESEND_PHRASE);
    expect(stub.clearDeliveryForResend).not.toHaveBeenCalled();
  });

  it('accepts the exact phrase', async () => {
    sessionUser.mockResolvedValue(admin);

    const result = await actions.resendTicketsAction(
      form({ attendeeIds: '[1]', reason: 'deleted it', confirmation: RESEND_PHRASE }),
    );

    expect(result.error).toBeNull();
    expect(stub.clearDeliveryForResend).toHaveBeenCalled();
  });
});

describe('a reason is required before a stamp moves', () => {
  it('refuses a blank reason on mark-delivered', async () => {
    sessionUser.mockResolvedValue(admin);

    const result = await actions.markDeliveredAction(form({ attendeeIds: '[1]', reason: '  ' }));

    expect(result.error).toContain('reason');
    expect(stub.markDelivered).not.toHaveBeenCalled();
  });
});

describe('malformed input is an error, not a stack', () => {
  /**
   * The selection travels through a hidden field as JSON, so it arrives as an
   * untrusted string. `JSON.parse` running before `zod` and outside a `try`
   * throws a raw `SyntaxError` across the Server Action boundary — where every
   * other failure here returns a structured error (`CLAUDE.md` conventions).
   */
  const HOSTILE = ['oops', '{', 'null', '"1"', '[1,', 'undefined'];

  it.each(HOSTILE)('rejects %j on mark-delivered without throwing', async (raw) => {
    sessionUser.mockResolvedValue(admin);

    const result = await actions.markDeliveredAction(form({ attendeeIds: raw, reason: 'x' }));

    expect(result.error).toBeTruthy();
    expect(stub.markDelivered).not.toHaveBeenCalled();
  });

  it.each(HOSTILE)('rejects %j on resend without throwing', async (raw) => {
    sessionUser.mockResolvedValue(admin);

    const result = await actions.resendTicketsAction(
      form({ attendeeIds: raw, reason: 'x', confirmation: RESEND_PHRASE }),
    );

    expect(result.error).toBeTruthy();
    expect(stub.clearDeliveryForResend).not.toHaveBeenCalled();
  });
});
