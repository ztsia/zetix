import { beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';

/**
 * Do the email and delivery Server Actions still **call** their guard?
 *
 * A different claim from "the guard works", and the one an independent QA pass
 * caught `D` and `F2` missing — deleting a guard call left both suites entirely
 * green. A Server Action is its own entry point: the page's guard does not
 * cover it and the proxy never reads a role (modules.md §5.2.1).
 *
 * These actions rewrite message wording, change a party's address and send
 * it mail, and render a guest's email, so an unguarded one is not a small
 * mistake. V1's blast actions went with the Email screen (spec/v3.md §24.1);
 * the send wizard's and the Messages view's took their place here.
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

/** Every mutation and read is stubbed: this file is about reaching them, not what they do. */
const stub = {
  editTemplateAndRerender: vi.fn(async () => ({ rerendered: 1, preserved: 0 })),
  selectedParties: vi.fn(async () => [1]),
  renderEmailPreview: vi.fn(async () => ({ toEmail: 'a@x', subject: 's', html: '', unknown: [], unissued: 0 })),
  loadMessage: vi.fn(async () => ({ id: 1, registrationId: 1, status: 'FAILED', subject: 's', bodyMd: 'b' })),
  startCommand: vi.fn(async () => ({ items: [{ status: 'DONE', outcome: {}, error: null }] })),
  changeContactEmail: vi.fn(async () => ({ issue: null, readdressed: 0 })),
};

vi.mock('@/lib/email/mutations', () => ({
  editTemplateAndRerender: () => stub.editTemplateAndRerender(),
}));
vi.mock('@/lib/email/defaults', () => ({ seedDefaultTemplates: async () => ({ inserted: 0 }) }));
vi.mock('@/lib/delivery/wizard', () => ({
  selectedParties: () => stub.selectedParties(),
  checkUncheckedAddresses: async () => ({ checked: 0, flagged: 0, left: 0 }),
  wizardSetup: async () => ({ segments: [], designs: [], templates: [], recipients: [] }),
  renderEmailPreview: () => stub.renderEmailPreview(),
}));
vi.mock('@/lib/delivery/messages', async (original) => ({
  ...(await original<typeof import('@/lib/delivery/messages')>()),
  loadMessage: () => stub.loadMessage(),
}));
vi.mock('@/lib/delivery/address', () => ({ changeContactEmail: () => stub.changeContactEmail() }));
vi.mock('@/lib/commands/runner', async (original) => ({
  ...(await original<typeof import('@/lib/commands/runner')>()),
  startCommand: () => stub.startCommand(),
}));

const templates = await import('@/app/(admin)/admin/concerts/[concertId]/email/actions');
const wizard = await import('@/app/(admin)/admin/concerts/[concertId]/audience/send/actions');
const messages = await import('@/app/(admin)/admin/concerts/[concertId]/audience/messages/actions');

const admin = { id: randomUUID(), role: 'ADMIN' as const, email: 'a@test', displayName: 'Admin' };
const operator = { ...admin, id: randomUUID(), role: 'OPERATOR' as const };
const viewer = { ...admin, id: randomUUID(), role: 'VIEWER' as const };

function form(entries: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(entries)) data.set(key, value);
  return data;
}

/** Each action, with input that would otherwise succeed. */
const CALLS: { name: string; run: () => Promise<unknown>; reached: () => unknown }[] = [
  {
    name: 'editTemplateAction',
    run: () => templates.editTemplateAction(form({ templateKey: 'public_ticket', subject: 's', bodyMd: 'b' })),
    reached: () => stub.editTemplateAndRerender,
  },
  {
    name: 'sendWizardSetupAction',
    run: () => wizard.sendWizardSetupAction(1, { ids: [1] }),
    reached: () => stub.selectedParties,
  },
  {
    name: 'emailPreviewAction',
    run: () => wizard.emailPreviewAction(1, 1, 'public_ticket', null),
    reached: () => stub.renderEmailPreview,
  },
  {
    name: 'loadMessageAction',
    run: () => messages.loadMessageAction(1, 1),
    reached: () => stub.loadMessage,
  },
  {
    name: 'editMessageAction',
    run: () => messages.editMessageAction(1, 1, 'Subject', 'Body'),
    reached: () => stub.startCommand,
  },
  {
    name: 'fixAddressAction',
    run: () => messages.fixAddressAction(1, 1, 'new@example.test'),
    reached: () => stub.changeContactEmail,
  },
];

beforeEach(() => {
  vi.clearAllMocks();
});

describe.each(CALLS)('$name', ({ run, reached }) => {
  it('redirects an anonymous caller to the login form and reaches nothing', async () => {
    sessionUser.mockResolvedValue(null);
    await expect(run()).rejects.toThrow(RedirectSignal);
    expect(reached()).not.toHaveBeenCalled();
  });

  /** An operator is signed in — the case a bare session check waves through. */
  it('turns a signed-in operator away and reaches nothing', async () => {
    sessionUser.mockResolvedValue(operator);
    await expect(run()).rejects.toThrow();
    expect(reached()).not.toHaveBeenCalled();
  });

  /** A viewer reads the console but never sends, edits or sees a ticket link (spec/v3.md §28). */
  it('turns a viewer away and reaches nothing', async () => {
    sessionUser.mockResolvedValue(viewer);
    await expect(run()).rejects.toThrow();
    expect(reached()).not.toHaveBeenCalled();
  });

  it('lets the admin through', async () => {
    sessionUser.mockResolvedValue(admin);
    await run();
    expect(reached()).toHaveBeenCalled();
  });
});
