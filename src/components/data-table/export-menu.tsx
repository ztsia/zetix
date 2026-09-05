'use client';

import * as React from 'react';
import { Download } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Spinner } from '@/components/ui/spinner';
import { toCsv, exportFilename, type ExportColumn } from '@/lib/export';

export type DataTableExport<TData> = {
  /** Base name; the date is appended. `registrations` → `registrations-2026-09-19.csv`. */
  filename: string;
  columns: readonly ExportColumn<TData>[];
  /** The concert's timezone — never the viewer's (`CLAUDE.md`). */
  timeZone: string;
  sheetName?: string;
};

/**
 * Exports what the operator is actually looking at.
 *
 * Two properties worth stating, because both are easy to get wrong and neither
 * is visible from the button:
 *
 * - **The current view, not the whole dataset.** Filters and sorting apply, so
 *   the file matches the screen. If rows are selected, only those are exported —
 *   which is how "export these twelve" works without a separate screen.
 * - **CSV is built in the browser; XLSX is built on the server.** `exceljs` is a
 *   server-side module, so the flattened rows are posted to a generic endpoint
 *   rather than shipping a spreadsheet writer into the admin bundle.
 */
export function DataTableExportMenu<TData>({
  rows,
  config,
  disabled,
  scopeNote,
}: {
  rows: readonly TData[];
  config: DataTableExport<TData>;
  disabled?: boolean;
  /** Names what `rows` actually covers when it is not the whole filtered set. */
  scopeNote?: string;
}) {
  const [busy, setBusy] = React.useState(false);

  function download(blob: Blob, filename: string) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    // The anchor must be **in the document** when it is clicked. A detached
    // anchor's click is ignored by Chromium, so the button appears to do
    // nothing at all — no error, no file.
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    // Revoked on the next tick: revoking synchronously races the download in
    // Safari and produces an empty file.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  function exportCsv() {
    const csv = toCsv(rows, config.columns, { timeZone: config.timeZone });
    download(
      new Blob([csv], { type: 'text/csv;charset=utf-8' }),
      exportFilename(config.filename, 'csv'),
    );
  }

  async function exportXlsx() {
    setBusy(true);
    try {
      const response = await fetch('/api/export/xlsx', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filename: config.filename,
          sheetName: config.sheetName ?? config.filename,
          headers: config.columns.map((column) => column.header),
          widths: config.columns.map((column) => column.width ?? null),
          rows: rows.map((row) =>
            config.columns.map((column) => {
              const value = column.value(row);
              if (value === null || value === undefined) return '';
              if (value instanceof Date) return { date: value.toISOString() };
              if (typeof value === 'boolean') return value ? 'yes' : 'no';
              return value;
            }),
          ),
          timeZone: config.timeZone,
        }),
      });
      if (!response.ok) throw new Error(`Export failed (${response.status})`);
      download(await response.blob(), exportFilename(config.filename, 'xlsx'));
    } finally {
      setBusy(false);
    }
  }

  const empty = rows.length === 0;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button variant="outline" size="sm" className="h-8" disabled={disabled || empty}>
            {busy ? <Spinner /> : <Download />}
            <span className="hidden sm:inline">Export</span>
          </Button>
        }
      />
      <DropdownMenuContent align="end">
        {/*
          The label is Base UI's `Menu.GroupLabel` and throws outside a
          `Menu.Group` — a runtime crash that empties the whole menu, not a
          styling nit. Every label in this codebase is wrapped for that reason.
        */}
        <DropdownMenuGroup>
          <DropdownMenuLabel>
            {rows.length} row{rows.length === 1 ? '' : 's'}
            {scopeNote ? ` · ${scopeNote}` : ''}
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={exportCsv}>CSV</DropdownMenuItem>
          <DropdownMenuItem onClick={exportXlsx} disabled={busy}>
            Excel (.xlsx)
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
