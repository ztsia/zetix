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
import { toCsv, exportFilename, XLSX_CELL_LIMIT, type ExportColumn } from '@/lib/export';

export type DataTableExport<TData> = {
  /** Base name; the date is appended. `registrations` → `registrations-2026-09-19.csv`. */
  filename: string;
  columns: readonly ExportColumn<TData>[];
  /** The concert's timezone — never the viewer's (`CLAUDE.md`). */
  timeZone: string;
  sheetName?: string;
  /**
   * **For a server-paged table: the rows to export, loaded when Export is
   * pressed** (spec/v3.md §32.1).
   *
   * Such a table holds one page, so exporting what it holds exported a page.
   * The loader is an `ADMIN`-only Server Action that resolves the same
   * selection the commands take — the ticked rows across every page, or the
   * whole filter minus what was unticked — and runs the listing's own query
   * with no page limit. Without it, the table exports what it holds, which in
   * client mode is already the whole filtered set.
   */
  load?: () => Promise<TData[] | { error: string }>;
};

/** What a whole-set export will cover, for the menu label. */
export type ExportScope = { count: number; label: string };

/**
 * Exports what the operator is actually looking at.
 *
 * Two properties worth stating, because both are easy to get wrong and neither
 * is visible from the button:
 *
 * - **The whole filtered set, never the page** (spec/v3.md §32.1). Filters and
 *   sorting apply, so the file matches the screen. If rows are selected, only
 *   those are exported — across every page — which is how "export these twelve"
 *   works without a separate screen. A server-paged table supplies `load`.
 * - **CSV is built in the browser; XLSX is built on the server.** `exceljs` is a
 *   server-side module, so the flattened rows are posted to a generic endpoint
 *   rather than shipping a spreadsheet writer into the admin bundle.
 */
export function DataTableExportMenu<TData>({
  rows,
  config,
  disabled,
  scope,
}: {
  /** What the table holds. Ignored when `config.load` is set. */
  rows: readonly TData[];
  config: DataTableExport<TData>;
  disabled?: boolean;
  /** With `config.load`: how many rows the export covers, and how to say it. */
  scope?: ExportScope;
}) {
  const [busy, setBusy] = React.useState(false);
  /** Said next to the button: a failed download must not look like nothing happened. */
  const [error, setError] = React.useState<string | null>(null);
  const count = scope?.count ?? rows.length;
  const label = scope?.label ?? `${count} row${count === 1 ? '' : 's'}`;
  /** Known before the request, so the menu can say so instead of a failed download. */
  const tooBigForExcel = count * config.columns.length > XLSX_CELL_LIMIT;

  /** The rows to write: loaded on the server for a whole-set export. */
  async function exportedRows(): Promise<readonly TData[] | null> {
    if (!config.load) return rows;
    const loaded = await config.load();
    if ('error' in loaded) {
      setError(loaded.error);
      return null;
    }
    return loaded;
  }

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

  async function exportCsv() {
    setBusy(true);
    setError(null);
    try {
      const data = await exportedRows();
      if (!data) return;
      const csv = toCsv(data, config.columns, { timeZone: config.timeZone });
      download(
        new Blob([csv], { type: 'text/csv;charset=utf-8' }),
        exportFilename(config.filename, 'csv'),
      );
    } catch {
      setError('The export failed. Try again in a moment.');
    } finally {
      setBusy(false);
    }
  }

  async function exportXlsx() {
    setBusy(true);
    setError(null);
    try {
      const data = await exportedRows();
      if (!data) return;
      if (data.length * config.columns.length > XLSX_CELL_LIMIT) {
        setError('That is too large for an Excel file. Export it as CSV instead.');
        return;
      }
      const response = await fetch('/api/export/xlsx', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filename: config.filename,
          sheetName: config.sheetName ?? config.filename,
          headers: config.columns.map((column) => column.header),
          widths: config.columns.map((column) => column.width ?? null),
          rows: data.map((row) =>
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
    } catch {
      setError('The export failed. Try again in a moment.');
    } finally {
      setBusy(false);
    }
  }

  const empty = count === 0;

  return (
    <div className="flex items-center gap-2">
      {error ? (
        <p role="alert" className="text-destructive max-w-64 text-xs">
          {error}
        </p>
      ) : null}
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
            <DropdownMenuLabel>Export {label}</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={exportCsv} disabled={busy}>
              CSV
            </DropdownMenuItem>
            <DropdownMenuItem onClick={exportXlsx} disabled={busy || tooBigForExcel}>
              Excel (.xlsx)
            </DropdownMenuItem>
            {tooBigForExcel ? (
              <p className="text-muted-foreground max-w-56 px-1.5 py-1 text-xs">
                Too many cells for an Excel file. CSV has no limit.
              </p>
            ) : null}
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
