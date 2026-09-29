import type { LucideIcon } from 'lucide-react';
import {
  DoorOpen,
  History,
  House,
  Inbox,
  LibraryBig,
  Settings,
  Settings2,
  Trash2,
  Users,
  ClipboardList,
} from 'lucide-react';

/**
 * The admin console's information architecture: seven areas per concert
 * (spec/v3.md §29.1).
 *
 * Kept as data rather than as markup so the sidebar, the area tabs and the
 * breadcrumb all read one description.
 *
 * **An area is a set of screens, not a URL prefix.** Each tab keeps the route
 * it had before V3 — `/shows`, `/checkin`, `/tickets/templates` — so every
 * `revalidatePath`, printed link and old email still points at a live screen.
 * What changed is where those routes sit in the navigation: the sidebar lists
 * the seven areas, and an area with more than one screen shows them as tabs.
 * Moving the routes would have bought a tidier address bar for a few hundred
 * edited paths and a redirect per screen.
 */
export type AreaTab = {
  /** The route under `/admin/concerts/{id}/`, as it has always been. */
  slug: string;
  label: string;
  description: string;
};

export type AreaId = 'home' | 'audience' | 'inbox' | 'intake' | 'door' | 'after' | 'setup';

export type Area = {
  id: AreaId;
  label: string;
  icon: LucideIcon;
  description: string;
  /** The first tab is where the sidebar link goes. */
  tabs: AreaTab[];
};

export const AREAS: Area[] = [
  {
    id: 'home',
    label: 'Home',
    icon: House,
    description: 'What needs a person, where every party is, the dates ahead and what is left to set up.',
    tabs: [{ slug: 'home', label: 'Home', description: 'The concert at a glance.' }],
  },
  {
    id: 'audience',
    label: 'Audience',
    icon: Users,
    description: 'Every party and seat, the party record, and every message.',
    tabs: [
      {
        slug: 'audience',
        label: 'Parties',
        description: 'Every party and seat, with its stage, its flags and the commands that move it on.',
      },
      {
        slug: 'audience/messages',
        label: 'Messages',
        description: 'Every message in every state, and what can be done with each.',
      },
    ],
  },
  {
    id: 'inbox',
    label: 'Inbox',
    icon: Inbox,
    description: 'Replies waiting for an answer, and messages that bounced.',
    tabs: [{ slug: 'inbox', label: 'Inbox', description: 'Open threads and bounces.' }],
  },
  {
    id: 'intake',
    label: 'Intake',
    icon: ClipboardList,
    description: 'Registration forms and spreadsheet imports.',
    tabs: [
      { slug: 'forms', label: 'Forms', description: 'Form builder, links, funnels and responses.' },
      { slug: 'import', label: 'Import', description: 'Upload, stage, fix and commit rows.' },
    ],
  },
  {
    id: 'door',
    label: 'Door',
    icon: DoorOpen,
    description: 'Live check-in, the scan log and the operators who scan.',
    tabs: [
      { slug: 'checkin', label: 'Check-in', description: 'Live dashboard and scan log.' },
      {
        slug: 'operators',
        label: 'Operators',
        description: 'Provision operators, assign shows, reset codes, deactivate.',
      },
    ],
  },
  {
    id: 'after',
    label: 'After',
    icon: LibraryBig,
    description: 'Feedback, notes and the wall, the portal and the booklet.',
    tabs: [
      {
        slug: 'feedback',
        label: 'Feedback',
        description: 'Each show’s feedback form and the email that carries it.',
      },
      { slug: 'notes', label: 'Notes', description: 'The wall, and per-player grouping.' },
      { slug: 'portal', label: 'Portal', description: 'Booklet upload and practical info.' },
    ],
  },
  {
    id: 'setup',
    label: 'Setup',
    icon: Settings2,
    description: 'The concert, its shows and segments, players, ticket designs and email templates.',
    tabs: [
      {
        slug: 'setup',
        label: 'Concert',
        description: 'Name, dates, timezone and the concert’s own settings.',
      },
      {
        slug: 'shows',
        label: 'Shows',
        description: 'Shows and their segments: capacity, quota, deadline, forms and delivery.',
      },
      {
        slug: 'players',
        label: 'Players',
        description: 'Players, CSV import, invite links, resend and rotate tokens.',
      },
      {
        slug: 'tickets/templates',
        label: 'Ticket designs',
        description: 'Ticket design editor and preview.',
      },
      {
        slug: 'email/templates',
        label: 'Email templates',
        description: 'The wording of every message, with merge fields and a preview.',
      },
    ],
  },
];

/** A console link outside the seven areas. */
export type NavItem = {
  slug: string;
  label: string;
  icon: LucideIcon;
  description: string;
};

/**
 * The concert's records: global in the sense of §29.1 — they belong to no
 * area, because every area writes to them — but still per concert, because
 * the audit log and the Trash are concert-scoped (§23.6).
 */
export const RECORD_ITEMS: NavItem[] = [
  {
    slug: 'activity',
    label: 'Activity',
    icon: History,
    description: 'Every change and every bulk command, with its report.',
  },
  {
    slug: 'trash',
    label: 'Trash',
    icon: Trash2,
    description: 'Deleted rows: restore them, or delete them permanently.',
  },
];

/** Settings holds the system defaults and the console's people (§29.1). */
export const SETTINGS_ITEM: NavItem = {
  slug: 'settings',
  label: 'Settings',
  icon: Settings,
  description: 'System defaults, and the people who can sign in.',
};

export const SETTINGS_TABS: { href: string; label: string }[] = [
  { href: '/admin/settings', label: 'System defaults' },
  { href: '/admin/settings/people', label: 'People' },
];

export const AREA_BY_ID = Object.fromEntries(AREAS.map((area) => [area.id, area])) as Record<
  AreaId,
  Area
>;

export type Location =
  | { kind: 'area'; area: Area; tab: AreaTab }
  | { kind: 'record'; item: NavItem };

/**
 * Where a path inside a concert sits: its area and tab, or one of the
 * records.
 *
 * `rest` is the path after `/admin/concerts/{id}/`. The longest slug that is a
 * whole-segment prefix wins, so `audience/messages/…` is Messages and
 * `audience/12` is Parties.
 */
export function locate(rest: string): Location | null {
  const path = rest.replace(/^\/+|\/+$/g, '');
  const within = (slug: string) => path === slug || path.startsWith(`${slug}/`);

  let best: { area: Area; tab: AreaTab } | null = null;
  for (const area of AREAS) {
    for (const tab of area.tabs) {
      if (within(tab.slug) && (!best || tab.slug.length > best.tab.slug.length)) {
        best = { area, tab };
      }
    }
  }
  if (best) return { kind: 'area', ...best };

  const item = RECORD_ITEMS.find((record) => within(record.slug));
  return item ? { kind: 'record', item } : null;
}

/** The path after `/admin/concerts/{id}/`, or null outside a concert. */
export function concertPath(pathname: string): { concertId: number; rest: string } | null {
  const match = /^\/admin\/concerts\/(\d+)(?:\/(.*))?$/.exec(pathname);
  return match ? { concertId: Number(match[1]), rest: match[2] ?? '' } : null;
}

export function areaHref(concertId: number, area: Area): string {
  return `/admin/concerts/${concertId}/${area.tabs[0]!.slug}`;
}
