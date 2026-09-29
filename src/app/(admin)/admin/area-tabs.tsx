'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';
import { concertPath, locate } from './nav';

export type LinkTab = { href: string; label: string; active: boolean };

/**
 * A row of links drawn as line tabs.
 *
 * **Links rather than `Tabs`**, as the form editor's tabs are: each tab is its
 * own route with its own URL state (a table's sort, a view), and a tab strip
 * that swapped panels client-side would lose it. The active tab is marked with
 * `aria-current` for a screen reader.
 */
export function LinkTabs({ label, tabs }: { label: string; tabs: LinkTab[] }) {
  return (
    <nav aria-label={label} className="-mt-2 flex gap-1 overflow-x-auto border-b">
      {tabs.map((tab) => (
        <Link
          key={tab.href}
          href={tab.href}
          aria-current={tab.active ? 'page' : undefined}
          className={cn(
            'relative inline-flex h-9 shrink-0 items-center rounded-t-md px-3 text-sm font-medium transition-colors',
            'hover:bg-muted focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none',
            tab.active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {tab.label}
          <span
            aria-hidden
            className={cn(
              'bg-primary absolute inset-x-2 -bottom-px h-0.5 rounded-t-sm transition-opacity',
              tab.active ? 'opacity-100' : 'opacity-0',
            )}
          />
        </Link>
      ))}
    </nav>
  );
}

/**
 * The screens of the area the current page is in (spec/v3.md §29.1), drawn
 * above every screen of a concert. An area with one screen draws nothing, and
 * so do the records (Activity, Trash), which belong to no area.
 */
export function AreaTabs() {
  const pathname = usePathname();
  const inside = concertPath(pathname);
  const here = inside ? locate(inside.rest) : null;
  if (!inside || here?.kind !== 'area' || here.area.tabs.length < 2) return null;

  const base = `/admin/concerts/${inside.concertId}`;
  return (
    <LinkTabs
      label={here.area.label}
      tabs={here.area.tabs.map((tab) => ({
        href: `${base}/${tab.slug}`,
        label: tab.label,
        active: tab.slug === here.tab.slug,
      }))}
    />
  );
}

/** System defaults · People — the two screens of Settings (§29.1). */
export function SettingsTabs({ tabs }: { tabs: { href: string; label: string }[] }) {
  const pathname = usePathname();
  return (
    <LinkTabs
      label="Settings"
      tabs={tabs.map((tab) => ({ ...tab, active: pathname === tab.href }))}
    />
  );
}
