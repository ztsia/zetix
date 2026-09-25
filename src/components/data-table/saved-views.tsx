'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { BookmarkPlus, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

/**
 * Saved views for a server-paged table (spec/v3.md §22.2).
 *
 * "A view is a named filter, encoded in the URL so it can be linked." So a view
 * here is nothing but a label and a query string: built-in views are passed by
 * the screen (one per stage, one per flag, each with its count), and the admin's
 * own are the current query string under a name they choose. Opening a view is
 * following a link, which is why a pasted link and a saved view are the same
 * thing.
 *
 * **The admin's own views live in this browser** (`localStorage`, keyed per
 * table). Nothing in the schema holds them, and a view is only a bookmark — the
 * link it wraps works on any machine. Moving them server-side, per named
 * account, is a small change once `R`'s accounts exist.
 */

export type BuiltInView = {
  id: string;
  label: string;
  /** The query string, with its leading `?`, or `''` for the unfiltered table. */
  query: string;
  count?: number;
};

type SavedView = { label: string; query: string };

/** Fired after this tab writes, since `storage` events only reach other tabs. */
const CHANGED = 'zetix:saved-views';

function subscribe(onChange: () => void) {
  window.addEventListener('storage', onChange);
  window.addEventListener(CHANGED, onChange);
  return () => {
    window.removeEventListener('storage', onChange);
    window.removeEventListener(CHANGED, onChange);
  };
}

function readRaw(key: string): string {
  try {
    return window.localStorage.getItem(key) ?? '[]';
  } catch {
    return '[]';
  }
}

function parseSaved(raw: string): SavedView[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter(
          (v): v is SavedView => typeof v?.label === 'string' && typeof v?.query === 'string',
        )
      : [];
  } catch {
    return [];
  }
}

/** Paging is not part of a view: a view opens at its first page. */
const withoutPaging = (query: string) => {
  const params = new URLSearchParams(query);
  params.delete('page');
  const out = params.toString();
  return out ? `?${out}` : '';
};

export function DataTableSavedViews({
  tableId,
  builtIn,
  currentQuery,
}: {
  /** Distinguishes one table's saved views from another's. */
  tableId: string;
  builtIn: BuiltInView[];
  currentQuery: string;
}) {
  const pathname = usePathname();
  const storageKey = `zetix:views:${tableId}`;
  // The server has no localStorage, so it renders no saved views and the
  // client fills them in after hydration without a mismatch.
  const raw = React.useSyncExternalStore(
    subscribe,
    () => readRaw(storageKey),
    () => '[]',
  );
  const saved = React.useMemo(() => parseSaved(raw), [raw]);
  const [name, setName] = React.useState('');
  const [open, setOpen] = React.useState(false);

  const current = withoutPaging(currentQuery);
  const persist = (next: SavedView[]) => {
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(next));
      window.dispatchEvent(new Event(CHANGED));
    } catch {
      // Storage full or disabled: the view simply is not remembered.
    }
  };

  const isBuiltIn = builtIn.some((view) => withoutPaging(view.query) === current);
  const isSaved = saved.some((view) => view.query === current);

  return (
    <nav aria-label="Views" className="flex flex-wrap items-center gap-1.5">
      {builtIn.map((view) => (
        <ViewLink
          key={view.id}
          href={`${pathname}${view.query}`}
          active={withoutPaging(view.query) === current}
          label={view.label}
          count={view.count}
        />
      ))}
      {saved.map((view) => (
        <span key={view.query} className="inline-flex items-center">
          <ViewLink
            href={`${pathname}${view.query}`}
            active={view.query === current}
            label={view.label}
          />
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={`Remove the view ${view.label}`}
            onClick={() => persist(saved.filter((v) => v.query !== view.query))}
          >
            <X />
          </Button>
        </span>
      ))}
      {!isBuiltIn && !isSaved && current && (
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger
            render={
              <Button variant="ghost" size="sm">
                <BookmarkPlus data-icon="inline-start" />
                Save view
              </Button>
            }
          />
          <PopoverContent className="w-64">
            <form
              className="flex gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                const label = name.trim();
                if (!label) return;
                persist([...saved, { label, query: current }]);
                setName('');
                setOpen(false);
              }}
            >
              <Input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Name this view"
                aria-label="View name"
                autoFocus
                maxLength={60}
              />
              <Button type="submit" size="sm" disabled={!name.trim()}>
                Save
              </Button>
            </form>
          </PopoverContent>
        </Popover>
      )}
    </nav>
  );
}

function ViewLink({
  href,
  active,
  label,
  count,
}: {
  href: string;
  active: boolean;
  label: string;
  count?: number;
}) {
  return (
    <Button
      variant={active ? 'secondary' : 'ghost'}
      size="sm"
      aria-current={active ? 'page' : undefined}
      className={cn(active && 'font-semibold')}
      render={<Link href={href} scroll={false} />}
      nativeButton={false}
    >
      {label}
      {count !== undefined && (
        <Badge variant="outline" className="tabular-nums">
          {count}
        </Badge>
      )}
    </Button>
  );
}
