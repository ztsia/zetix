import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, sql } from '../helpers/db';
import {
  createConcert,
  createRegistration,
  createSegment,
  createShow,
  withDirectAttendeeWrites,
} from '../helpers/fixtures';

/**
 * The two editor screens, on the server side.
 *
 * No browser: this calls the real page components and inspects the props they
 * hand their client components — the guard, the seeding, the scoping and the
 * preview data. **How the canvas looks is not covered here and cannot be**,
 * because signing in needs an admin code no cloud session holds (`local.md` §7).
 * That is queued as a human task, exactly as module `D` queued the same gap for
 * the tickets screen.
 */

class RedirectSignal extends Error {
  constructor(readonly to: string) {
    super(`redirect:${to}`);
  }
}
class NotFoundSignal extends Error {}

vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new RedirectSignal(to);
  },
  notFound: () => {
    throw new NotFoundSignal('notFound');
  },
}));

const sessionUser = vi.fn();
vi.mock('@/lib/auth/session', () => ({
  getSessionUser: () => sessionUser(),
  recordLogin: async () => {},
}));

const TemplatesPage = (
  await import('@/app/(admin)/admin/concerts/[concertId]/tickets/templates/page')
).default;
const EditorPage = (
  await import(
    '@/app/(admin)/admin/concerts/[concertId]/tickets/templates/[templateId]/page'
  )
).default;
const { listTemplates } = await import('@/lib/tickets/templates');

let concertId: number;
let showId: number;
let segmentId: number;

beforeEach(async () => {
  await resetDb();
  sessionUser.mockReset();
  process.env.APP_URL ??= 'https://zetix.vercel.app';

  const admin = randomUUID();
  await sql`
    insert into app_users (id, email, display_name, role)
    values (${admin}::uuid, ${`a-${admin}@example.test`}, 'Committee', 'ADMIN')
  `;
  sessionUser.mockResolvedValue({
    id: admin,
    email: 'a@x',
    displayName: 'Committee',
    role: 'ADMIN',
  });

  concertId = await createConcert('Editor screens');
  showId = await createShow(concertId, 100);
  segmentId = await createSegment(showId, { capacity: 50, audienceMode: 'PUBLIC' });
});

/**
 * The props the page hands `TemplateEditor`, found by walking the returned
 * tree.
 *
 * A React element cannot be stringified — it holds a circular reference — and
 * the editor sits several nodes down inside the page's layout, so this looks
 * for the one node carrying `previewOptions` rather than assuming a position
 * that a wrapper div would break.
 */
type EditorProps = {
  template: { id: number; name: string; version: number };
  shows: { id: number; name: string }[];
  showId: number | null;
  previewOptions: { subject: string; fullName: string; label: string }[];
  previewData: { attendee: { fullName: string } };
};

function findEditorProps(node: unknown): EditorProps | null {
  if (!node || typeof node !== 'object') return null;
  const element = node as { props?: Record<string, unknown> };
  if (element.props && 'previewOptions' in element.props) {
    return element.props as unknown as EditorProps;
  }
  const children = element.props?.children;
  for (const child of Array.isArray(children) ? children : [children]) {
    const found = findEditorProps(child);
    if (found) return found;
  }
  return null;
}

/** Every string the page rendered, for the cases where no editor is mounted. */
function textOf(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(' ');
  if (!node || typeof node !== 'object') return '';
  const element = node as { props?: { children?: unknown } };
  return textOf(element.props?.children);
}

async function outcome(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return 'allowed';
  } catch (error) {
    if (error instanceof RedirectSignal) return `redirect:${error.to}`;
    if (error instanceof NotFoundSignal) return 'notFound';
    throw error;
  }
}

const renderList = (id: number | string) =>
  TemplatesPage({ params: Promise.resolve({ concertId: String(id) }) });

const renderEditor = (
  templateId: number | string,
  query: Record<string, string> = {},
  concert: number | string = concertId,
) =>
  EditorPage({
    params: Promise.resolve({
      concertId: String(concert),
      templateId: String(templateId),
    }),
    searchParams: Promise.resolve(query),
  });

describe('the template list', () => {
  it('seeds the defaults on first open, so the screen is never empty', async () => {
    // Module D seeds lazily, on first render. Opening the editor is such a
    // moment: an admin who came to lay out artwork should find three working
    // designs, not an empty page.
    expect(await listTemplates(concertId)).toHaveLength(0);
    await renderList(concertId);
    expect((await listTemplates(concertId)).map((t) => t.name).sort()).toEqual([
      'Classic Landscape',
      'Minimal Portrait',
      'Wide Banner',
    ]);
  });

  it('seeds once, however often it is opened', async () => {
    await renderList(concertId);
    await renderList(concertId);
    expect(await listTemplates(concertId)).toHaveLength(3);
  });

  it('turns away an operator and a visitor', async () => {
    sessionUser.mockResolvedValue({ id: 'x', email: 'o@x', displayName: 'Wei', role: 'OPERATOR' });
    expect(await outcome(() => renderList(concertId))).not.toBe('allowed');

    sessionUser.mockResolvedValue(null);
    expect(await outcome(() => renderList(concertId))).toMatch(/^redirect:/);
  });

  it('404s on a concert that does not exist', async () => {
    expect(await outcome(() => renderList(999_999))).toBe('notFound');
    expect(await outcome(() => renderList('nonsense'))).toBe('notFound');
  });
});

describe('the editor page', () => {
  async function seededTemplateId(): Promise<number> {
    await renderList(concertId);
    return (await listTemplates(concertId))[0].id;
  }

  it('hands the editor the template, the shows and the preview data', async () => {
    const registrationId = await createRegistration({ showId, segmentId });
    await withDirectAttendeeWrites(async (tx) => {
      for (const name of ['Jo Ng', 'Wellington Mainwaring-Fitzgerald']) {
        await tx`
          insert into attendees (
            registration_id, show_id, segment_id, full_name, name_source,
            allocation_type, status
          ) values (
            ${registrationId}, ${showId}, ${segmentId}, ${name}, 'PROVIDED',
            'BASE', 'CONFIRMED'
          )
        `;
      }
    });

    const templateId = await seededTemplateId();
    const props = findEditorProps(await renderEditor(templateId));

    expect(props?.template).toMatchObject({ id: templateId, name: 'Classic Landscape' });
    expect(props?.shows).toEqual([{ id: showId, name: 'Test Show' }]);
    expect(props?.showId).toBe(showId);

    // The longest-name option is the one §10.3 exists for; if it stops being
    // offered the check quietly disappears from the screen.
    const longest = props?.previewOptions.find((o) => o.subject === 'LONGEST_NAME');
    expect(longest?.fullName).toBe('Wellington Mainwaring-Fitzgerald');
    expect(props?.previewData.attendee.fullName).toBe('Jo Ng');
  });

  it('still opens for a concert with no attendees, on sample data', async () => {
    const templateId = await seededTemplateId();
    const props = findEditorProps(await renderEditor(templateId));
    expect(props?.previewOptions.map((o) => o.subject)).toEqual(['SAMPLE']);
    expect(props?.previewData.attendee.fullName).toBeTruthy();
  });

  it('opens for a concert with no shows at all', async () => {
    // A template is often laid out before the hall is booked. This must not
    // crash; it says there is nothing to preview against.
    const bare = await createConcert('No shows yet');
    await renderList(bare);
    const templateId = (await listTemplates(bare))[0].id;
    const page = await renderEditor(templateId, {}, bare);
    expect(findEditorProps(page)).toBeNull();
    expect(textOf(page)).toMatch(/no shows yet/i);
  });

  it('404s on another concert’s template', async () => {
    // Loaded by (concertId, templateId), never by id alone — otherwise a
    // template from another concert opens here and saves into this one.
    const other = await createConcert('Not ours');
    await renderList(other);
    const theirs = (await listTemplates(other))[0].id;
    expect(await outcome(() => renderEditor(theirs))).toBe('notFound');
  });

  it('404s on a template that does not exist', async () => {
    expect(await outcome(() => renderEditor(999_999))).toBe('notFound');
    expect(await outcome(() => renderEditor('nonsense'))).toBe('notFound');
  });

  it('turns away an operator and a visitor', async () => {
    const templateId = await seededTemplateId();

    sessionUser.mockResolvedValue({ id: 'x', email: 'o@x', displayName: 'Wei', role: 'OPERATOR' });
    expect(await outcome(() => renderEditor(templateId))).not.toBe('allowed');

    sessionUser.mockResolvedValue(null);
    expect(await outcome(() => renderEditor(templateId))).toMatch(/^redirect:/);
  });
});
