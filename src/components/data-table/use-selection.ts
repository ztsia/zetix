'use client';

import * as React from 'react';
import type { RowSelectionState } from '@tanstack/react-table';
import type { Selection } from '@/lib/commands/selection';

/**
 * Selection as a query (spec/v3.md §22.3), for any server-paged `DataTable`.
 *
 * Two modes, mirroring {@link Selection}:
 *
 * - **Ticked rows** — ids, kept across pages, because the table is controlled
 *   and keyed by `getRowId`.
 * - **All matching** — the filter itself. Every row on every page shows ticked;
 *   unticking one adds it to `excludedIds`. The browser never assembles the list
 *   of matching ids; the command resolves the filter on the server.
 *
 * **Changing the filter clears the selection.** "All 244 matching" means those
 * 244; the same words after the search box changed would mean something
 * else, and a selection that silently widened is how a bulk command reaches
 * rows nobody looked at. `filterKey` is how the hook knows: pass a string that
 * changes whenever the filter does.
 */
export function useTableSelection<F>(options: {
  filter: F;
  filterKey: string;
  /** Rows matching the filter, across every page. */
  total: number;
  /** Ids of the rows on the current page, as `getRowId` returns them. */
  pageIds: string[];
}) {
  const { filter, filterKey, total, pageIds } = options;
  const [mode, setMode] = React.useState<'ids' | 'all'>('ids');
  const [ids, setIds] = React.useState<Set<string>>(new Set());
  const [excluded, setExcluded] = React.useState<Set<string>>(new Set());

  const [lastKey, setLastKey] = React.useState(filterKey);
  if (lastKey !== filterKey) {
    // Reset during render rather than in an effect, so no frame ever shows the
    // old selection against the new filter.
    setLastKey(filterKey);
    setMode('ids');
    setIds(new Set());
    setExcluded(new Set());
  }

  const rowSelection: RowSelectionState = React.useMemo(() => {
    const out: RowSelectionState = {};
    if (mode === 'all') {
      for (const id of pageIds) if (!excluded.has(id)) out[id] = true;
    } else {
      for (const id of ids) out[id] = true;
    }
    return out;
  }, [mode, ids, excluded, pageIds]);

  function onRowSelectionChange(next: RowSelectionState) {
    if (mode === 'all') {
      const nextExcluded = new Set(excluded);
      for (const id of pageIds) {
        if (next[id]) nextExcluded.delete(id);
        else nextExcluded.add(id);
      }
      setExcluded(nextExcluded);
      return;
    }
    // Ids on other pages are untouched: `next` only knows this page.
    const nextIds = new Set([...ids].filter((id) => !pageIds.includes(id)));
    for (const id of pageIds) if (next[id]) nextIds.add(id);
    setIds(nextIds);
  }

  const clear = React.useCallback(() => {
    setMode('ids');
    setIds(new Set());
    setExcluded(new Set());
  }, []);

  const count = mode === 'all' ? Math.max(0, total - excluded.size) : ids.size;

  const selection: Selection<F> | null =
    count === 0
      ? null
      : mode === 'all'
        ? { filter, excludedIds: [...excluded].map(Number) }
        : { ids: [...ids].map(Number) };

  return {
    selection,
    count,
    clear,
    tableProps: {
      rowSelection,
      onRowSelectionChange,
      selectAllMatching: {
        // Once nothing matches any more — the run just emptied the filter —
        // "all 0 selected" would be a claim about nothing.
        selected: mode === 'all' && count > 0,
        total,
        excluded: excluded.size,
        onSelect: () => {
          setMode('all');
          setExcluded(new Set());
        },
        onClear: clear,
      },
    },
  };
}
