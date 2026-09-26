import type { LucideIcon } from 'lucide-react';
import {
  CalendarDays,
  Download,
  FileSpreadsheet,
  FileText,
  Gauge,
  History,
  Inbox,
  Mail,
  MessageSquareQuote,
  ScanLine,
  Settings,
  Smartphone,
  Ticket,
  Trash2,
  UserCog,
  UserRoundCog,
  Users,
  UsersRound,
} from 'lucide-react';

/**
 * The admin console's information architecture, exactly as spec/admin.md §14.1
 * lists it.
 *
 * Kept as data rather than as markup so the sidebar, the breadcrumb and the
 * route skeleton all read from one description. Wave-2 modules fill these pages
 * in; **the shape is F2's and should not be edited to add a module's own page**
 * without a reason — the nav is one of the few files eight parallel sessions all
 * touch (spec/modules.md §4).
 *
 * `module` records which branch owns the screen, so an empty page can say who is
 * building it instead of looking broken.
 */
export type NavItem = {
  slug: string;
  label: string;
  icon: LucideIcon;
  description: string;
  module: string;
};

/** An empty `label` renders the group with no heading — see `app-sidebar.tsx`. */
export type NavGroup = { label: string; items: NavItem[] };

/** Everything under `/admin/concerts/{id}`. */
export const CONCERT_NAV: NavGroup[] = [
  {
    // No heading: a one-item group whose label repeats the item is 48px of the
    // sidebar's height spent saying nothing, and the sidebar has to fit a 720px
    // laptop with every group visible.
    label: '',
    items: [
      {
        slug: 'overview',
        label: 'Overview',
        icon: Gauge,
        description: 'Capacity across all shows, at-a-glance status.',
        module: 'A',
      },
    ],
  },
  {
    label: 'Configuration',
    items: [
      {
        slug: 'shows',
        label: 'Shows',
        icon: CalendarDays,
        description:
          'Shows and their segments: capacity, quota, deadline, policy and portal mode.',
        module: 'A',
      },
      {
        slug: 'players',
        label: 'Players',
        icon: UsersRound,
        description: 'Players, CSV import, invite links, resend and rotate tokens.',
        module: 'A',
      },
      {
        slug: 'forms',
        label: 'Forms',
        icon: FileText,
        description: 'Form builder, preview, open and close, response list.',
        module: 'V2',
      },
      {
        // The Tickets table became the Audience workspace's Seats grain
        // (spec/v3.md §22.1). The design and wording editors are setup, not
        // delivery (§29.1), so they sit here; `W` gives them their Setup home.
        slug: 'tickets/templates',
        label: 'Ticket designs',
        icon: Ticket,
        description: 'Ticket design editor and preview.',
        module: 'D / E',
      },
      {
        slug: 'email/templates',
        label: 'Email templates',
        icon: Mail,
        description: 'The wording of every message, with merge fields and a preview.',
        module: 'F',
      },
    ],
  },
  {
    label: 'Audience',
    items: [
      {
        // V3's one table over every party and seat (spec/v3.md §22). It replaced
        // Registrations, Unverified and Extras review, whose old URLs redirect
        // here with the matching view.
        slug: 'audience',
        label: 'Audience',
        icon: Users,
        description: 'Every party and seat, with its stage, its flags and the commands that move it on.',
        module: 'S',
      },
      {
        // Every message of the concert, in every status, with its exit
        // (spec/v3.md §24.4). It replaced Email and Email › Delivery, whose old
        // URLs redirect here.
        slug: 'audience/messages',
        label: 'Messages',
        icon: Inbox,
        description: 'Every message in every state, and what can be done with each.',
        module: 'T',
      },
      {
        slug: 'import',
        label: 'Import',
        icon: FileSpreadsheet,
        description: 'Upload, map, validate, dry run, commit.',
        module: 'C',
      },
    ],
  },
  {
    label: 'Delivery',
    items: [
      {
        slug: 'checkin',
        label: 'Check-in',
        icon: ScanLine,
        description: 'Live dashboard and scan log.',
        module: 'H',
      },
      {
        slug: 'operators',
        label: 'Operators',
        icon: UserCog,
        description: 'Provision operators, assign shows, reset codes, deactivate.',
        module: 'H',
      },
    ],
  },
  {
    label: 'After the concert',
    items: [
      {
        slug: 'portal',
        label: 'Portal',
        icon: Smartphone,
        /**
         * Unlock mode is deliberately not on this screen: it is a per-show value
         * and the Shows screen edits it with a cascade hint beside it.
         */
        description: 'Booklet upload and practical info.',
        module: 'N',
      },
      {
        slug: 'notes',
        label: 'Notes',
        icon: MessageSquareQuote,
        description: 'The wall, and per-player grouping.',
        module: 'O',
      },
      {
        slug: 'exports',
        label: 'Exports',
        icon: Download,
        description: 'CSV or XLSX of any table view.',
        module: 'F2',
      },
    ],
  },
  {
    // V3's record-keeping screens (spec/v3.md §23.1, §23.6). `W` folds the nav
    // into its seven areas (§29.1); until then they sit together here.
    label: 'Records',
    items: [
      {
        slug: 'activity',
        label: 'Activity',
        icon: History,
        description: 'Every change and every bulk command, with its report.',
        module: 'Q',
      },
      {
        slug: 'trash',
        label: 'Trash',
        icon: Trash2,
        description: 'Deleted rows: restore them, or delete them permanently.',
        module: 'Q',
      },
    ],
  },
];

export const CONCERT_NAV_ITEMS: NavItem[] = CONCERT_NAV.flatMap((group) => group.items);

export const SETTINGS_ITEM: NavItem = {
  slug: 'settings',
  label: 'Settings',
  icon: Settings,
  description: 'Users, roles, system defaults, SMTP test, audit log.',
  module: 'A',
};

/**
 * Settings › People (spec/v3.md §28, module `R`). Beside Settings in the
 * sidebar footer rather than in a concert's groups: accounts belong to the
 * console, not to a concert. `W` folds both into its seven areas (§29.1).
 */
export const PEOPLE_ITEM: NavItem = {
  slug: 'settings/people',
  label: 'People',
  icon: UserRoundCog,
  description: 'Named console accounts: admins and read-only viewers.',
  module: 'R',
};

export function findNavItem(slug: string): NavItem | undefined {
  // `tickets` finds `tickets/templates`: the breadcrumb passes only the first
  // path segment.
  return (
    CONCERT_NAV_ITEMS.find((item) => item.slug === slug) ??
    CONCERT_NAV_ITEMS.find((item) => item.slug.split('/')[0] === slug)
  );
}
