'use client';

import { Fragment } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import { Separator } from '@/components/ui/separator';
import { SidebarTrigger } from '@/components/ui/sidebar';
import { areaHref, concertPath, locate } from './nav';

/**
 * The breadcrumb header (spec/surfaces.md §15.1).
 *
 * Derived from the path rather than assembled by each page, so a wave-2 module
 * that adds a screen gets a correct breadcrumb without touching this file — and
 * cannot give its screen a different chrome from every other screen.
 */
/** What a route below each screen opens. */
const DEEPER: Record<string, string> = {
  audience: 'Party',
  inbox: 'Thread',
  forms: 'Form',
  import: 'Batch',
  'tickets/templates': 'Design',
};

export function AdminHeader() {
  const pathname = usePathname();
  const segments = pathname.split('/').filter(Boolean);

  const crumbs: { label: string; href?: string }[] = [{ label: 'Admin', href: '/admin/concerts' }];

  if (segments[1] === 'settings' && segments[2] === 'people') {
    crumbs.push({ label: 'Settings', href: '/admin/settings' }, { label: 'People' });
  } else if (segments[1] === 'settings') {
    crumbs.push({ label: 'Settings' });
  } else if (segments[1] === 'concerts') {
    const inside = concertPath(pathname);
    if (!inside) {
      crumbs.push({ label: 'Concerts' });
    } else {
      crumbs.push({ label: 'Concerts', href: '/admin/concerts' });
      const here = locate(inside.rest);
      if (here?.kind === 'record') {
        crumbs.push({ label: here.item.label });
      } else if (here?.kind === 'area') {
        // Area, then the screen when the area has more than one — and then
        // what is open below a screen's own route (a party, a thread, a
        // form), with the screen linked back.
        const tabHref = `/admin/concerts/${inside.concertId}/${here.tab.slug}`;
        const deeper = pathname !== tabHref;
        if (here.area.tabs.length > 1) {
          crumbs.push({ label: here.area.label, href: areaHref(inside.concertId, here.area) });
          crumbs.push({ label: here.tab.label, href: deeper ? tabHref : undefined });
        } else {
          crumbs.push({ label: here.area.label, href: deeper ? tabHref : undefined });
        }
        if (deeper) crumbs.push({ label: DEEPER[here.tab.slug] ?? 'Detail' });
      } else {
        crumbs.push({ label: 'Concert' });
      }
    }
  }

  return (
    <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
      <SidebarTrigger className="-ml-1" />
      <Separator orientation="vertical" className="mr-2 h-4" />
      <Breadcrumb>
        <BreadcrumbList>
          {crumbs.map((crumb, index) => {
            const last = index === crumbs.length - 1;
            return (
              // `BreadcrumbSeparator` is itself an `<li>`, so it has to be a
              // *sibling* of the item, not a child. Nesting it produces
              // `<li><li>`, which is invalid markup and fails hydration.
              <Fragment key={`${crumb.label}-${index}`}>
                <BreadcrumbItem>
                  {last || !crumb.href ? (
                    <BreadcrumbPage>{crumb.label}</BreadcrumbPage>
                  ) : (
                    <BreadcrumbLink render={<Link href={crumb.href} />}>
                      {crumb.label}
                    </BreadcrumbLink>
                  )}
                </BreadcrumbItem>
                {!last && <BreadcrumbSeparator />}
              </Fragment>
            );
          })}
        </BreadcrumbList>
      </Breadcrumb>
    </header>
  );
}
