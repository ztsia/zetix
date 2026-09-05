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
import { findNavItem } from './nav';

/**
 * The breadcrumb header (spec/surfaces.md §15.1).
 *
 * Derived from the path rather than assembled by each page, so a wave-2 module
 * that adds a screen gets a correct breadcrumb without touching this file — and
 * cannot give its screen a different chrome from every other screen.
 */
export function AdminHeader() {
  const pathname = usePathname();
  const segments = pathname.split('/').filter(Boolean);

  const crumbs: { label: string; href?: string }[] = [{ label: 'Admin', href: '/admin/concerts' }];

  if (segments[1] === 'settings') {
    crumbs.push({ label: 'Settings' });
  } else if (segments[1] === 'concerts') {
    if (segments.length === 2) {
      crumbs.push({ label: 'Concerts' });
    } else {
      crumbs.push({ label: 'Concerts', href: '/admin/concerts' });
      const slug = segments[3];
      const item = slug ? findNavItem(slug) : undefined;
      crumbs.push({ label: item?.label ?? 'Concert' });
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
