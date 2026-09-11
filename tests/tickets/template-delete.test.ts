import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, sql } from '../helpers/db';
import {
  createConcert,
  createRegistration,
  createSegment,
  createShow,
  seedAttendees,
} from '../helpers/fixtures';
import { issueTickets } from '@/lib/tickets/issue';
import { ensureConcertTemplates } from '@/lib/tickets/seed-templates';
import {
  deleteTemplate,
  duplicateTemplate,
  listTemplates,
  setDefaultTemplate,
} from '@/lib/tickets/templates';

vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('@/lib/auth/session', () => ({
  getSessionUser: async () => ({
    id: '00000000-0000-0000-0000-000000000001',
    email: 'a@x',
    displayName: 'Committee',
    role: 'ADMIN',
  }),
  recordLogin: async () => {},
}));

/**
 * Deleting a ticket template (spec/tickets.md §10.5).
 *
 * The rule the refusals protect is the same one `template-save.test.ts` is
 * built around: **a ticket somebody already holds must keep rendering.** The
 * PDF is produced on demand from the pinned
 * `(ticket_template_id, ticket_template_version)`, so a template that any
 * ticket points at cannot be allowed to leave.
 */
let concertId: number;
let showId: number;
let segmentId: number;

beforeEach(async () => {
  await resetDb();
  process.env.APP_URL ??= 'https://zetix.vercel.app';

  concertId = await createConcert('Templates');
  showId = await createShow(concertId, 100);
  segmentId = await createSegment(showId, { capacity: 50, audienceMode: 'PUBLIC' });
  await ensureConcertTemplates(concertId);
});

async function templateNamed(name: string) {
  const found = (await listTemplates(concertId)).find((t) => t.name === name);
  if (!found) throw new Error(`No template called ${name}`);
  return found;
}

/** A template nothing points at and which is not the default. */
async function spareTemplate() {
  const source = await templateNamed('Classic Landscape');
  const { templateId } = await duplicateTemplate(concertId, source.id);
  return templateId;
}

async function issueAll(): Promise<void> {
  const registrationId = await createRegistration({ showId, segmentId });
  await seedAttendees({ registrationId, showId, segmentId, count: 2, allocationType: 'BASE' });
  await issueTickets({ concertId, showId });
}

describe('an unused template', () => {
  it('is soft-deleted and leaves the list', async () => {
    const templateId = await spareTemplate();
    expect((await listTemplates(concertId)).some((t) => t.id === templateId)).toBe(true);

    await deleteTemplate(concertId, templateId);

    expect((await listTemplates(concertId)).some((t) => t.id === templateId)).toBe(false);
    const [row] = await sql<{ deleted_at: Date | null }[]>`
      select deleted_at from ticket_templates where id = ${templateId}
    `;
    // Soft: the row stays, so a ticket that somehow still points at it can
    // still be explained rather than dangling.
    expect(row.deleted_at).not.toBeNull();
  });

  it('refuses a second delete of the same template', async () => {
    const templateId = await spareTemplate();
    await deleteTemplate(concertId, templateId);

    await expect(deleteTemplate(concertId, templateId)).rejects.toThrow(/no longer exists/i);
  });

  /**
   * Probing another concert's ids must not tell "not yours" from "not there"
   * (modules.md §5.2.1), and must certainly not delete it.
   */
  it('refuses a template belonging to another concert', async () => {
    const otherConcert = await createConcert('Someone else');
    await ensureConcertTemplates(otherConcert);
    const theirs = (await listTemplates(otherConcert))[0];

    await expect(deleteTemplate(concertId, theirs.id)).rejects.toThrow(/no longer exists/i);

    const [row] = await sql<{ deleted_at: Date | null }[]>`
      select deleted_at from ticket_templates where id = ${theirs.id}
    `;
    expect(row.deleted_at).toBeNull();
  });
});

describe('a template tickets are pinned to', () => {
  /**
   * The refusal that matters. Reissuing re-renders from the pinned row, so
   * deleting the version a delivered ticket points at would break a PDF
   * already in someone's inbox.
   */
  it('cannot be deleted, and says how many tickets are pinned', async () => {
    await issueAll();
    const [pinned] = await sql<{ id: string; count: number }[]>`
      select t.id, count(a.id)::int as count
        from ticket_templates t
        join attendees a on a.ticket_template_id = t.id
                        and a.ticket_template_version = t.version
       where t.concert_id = ${concertId}
       group by t.id
    `;

    await expect(deleteTemplate(concertId, Number(pinned.id))).rejects.toThrow(
      /2 tickets are pinned/i,
    );
  });

  it('leaves the template in place after the refusal', async () => {
    await issueAll();
    const [pinned] = await sql<{ id: string }[]>`
      select t.id from ticket_templates t
        join attendees a on a.ticket_template_id = t.id
       where t.concert_id = ${concertId} limit 1
    `;

    await expect(deleteTemplate(concertId, Number(pinned.id))).rejects.toThrow();

    const [row] = await sql<{ deleted_at: Date | null }[]>`
      select deleted_at from ticket_templates where id = ${pinned.id}
    `;
    expect(row.deleted_at).toBeNull();
  });
});

describe('the default template', () => {
  /**
   * It is what `resolveTemplateForShow()` falls back to. Deleting it makes the
   * next issue fail with a question about templates rather than about the
   * ticket being issued.
   */
  it('cannot be deleted while it is the default', async () => {
    const spare = await spareTemplate();
    await setDefaultTemplate(concertId, spare);

    await expect(deleteTemplate(concertId, spare)).rejects.toThrow(/default template/i);
  });

  it('can be deleted once another template is made the default', async () => {
    const spare = await spareTemplate();
    await setDefaultTemplate(concertId, spare);
    const other = await templateNamed('Classic Landscape');
    await setDefaultTemplate(concertId, other.id);

    await deleteTemplate(concertId, spare);

    expect((await listTemplates(concertId)).some((t) => t.id === spare)).toBe(false);
  });
});
