'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';

/**
 * Questions · Responses · Settings — Google Forms' three tabs, as links.
 *
 * **Links rather than `Tabs`**, because each is its own route: the responses
 * table keeps its sort and page in the URL (so a narrowed view is shareable),
 * and a settings save should not have to re-render the builder. A tab strip
 * that swapped panels client-side would lose both. The active tab is read from
 * the path, and marked with `aria-current` for a screen reader.
 */
export function FormTabs({
  basePath,
  responses,
}: {
  basePath: string;
  responses: number;
}) {
  const pathname = usePathname();
  const tabs = [
    { href: basePath, label: 'Questions', active: pathname === basePath },
    {
      href: `${basePath}/responses`,
      label: 'Responses',
      count: responses,
      active: pathname.startsWith(`${basePath}/responses`),
    },
    {
      href: `${basePath}/settings`,
      label: 'Settings',
      active: pathname.startsWith(`${basePath}/settings`),
    },
  ];

  return (
    <nav aria-label="Form" className="flex justify-center gap-1">
      {tabs.map((tab) => (
        <Link
          key={tab.href}
          href={tab.href}
          aria-current={tab.active ? 'page' : undefined}
          className={cn(
            'relative inline-flex h-10 items-center gap-1.5 rounded-t-md px-3 text-sm font-medium transition-colors',
            'hover:bg-form-accent-soft focus-visible:ring-form-accent focus-visible:ring-2 focus-visible:outline-none',
            tab.active ? 'text-form-accent' : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {tab.label}
          {tab.count ? (
            <span
              className={cn(
                'rounded-full px-1.5 text-xs tabular-nums',
                tab.active ? 'bg-form-accent text-form-accent-foreground' : 'bg-muted',
              )}
            >
              {tab.count}
            </span>
          ) : null}
          {/* Google Forms' underline: a 3px bar with rounded top corners. */}
          <span
            aria-hidden
            className={cn(
              'bg-form-accent absolute inset-x-2 bottom-0 h-[3px] rounded-t-[3px] transition-opacity',
              tab.active ? 'opacity-100' : 'opacity-0',
            )}
          />
        </Link>
      ))}
    </nav>
  );
}
