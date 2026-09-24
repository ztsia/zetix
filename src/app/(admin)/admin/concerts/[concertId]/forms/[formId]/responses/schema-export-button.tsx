'use client';

import { useState, useTransition } from 'react';
import { Download } from 'lucide-react';
import { Alert, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { DataTableExportMenu } from '@/components/data-table';
import { Spinner } from '@/components/ui/spinner';
import type { ExportColumn, ExportValue } from '@/lib/export';
import { buildFormExportAction, type FormExport } from './export-actions';

/**
 * The §8.5 export: every response, with columns from each one's pinned schema.
 *
 * Two steps on purpose. The table is built on the server — only there can the
 * pinned schemas be read — and then handed to the shared export menu, which is
 * what already knows how to write a CSV in the browser and post an XLSX to
 * `/api/export/xlsx`. Reusing it means this module ships no download code of
 * its own and inherits the fixes that menu has already had.
 *
 * The rows arrive as flat cell arrays, so the `ExportColumn` list is generated
 * to index into them. That is the shared shape's one accommodation for a table
 * whose columns are not known until the data is read.
 */

type CellRow = { cells: ExportValue[] };

export function SchemaExportButton({
  concertId,
  formId,
  count,
}: {
  concertId: number;
  formId: number;
  count: number;
}) {
  const [table, setTable] = useState<FormExport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function build() {
    setError(null);
    startTransition(async () => {
      const result = await buildFormExportAction(concertId, formId);
      if (result.error) {
        setError(result.error);
        return;
      }
      setTable(result.data);
    });
  }

  if (table) {
    const columns: ExportColumn<CellRow>[] = table.headers.map((header, index) => ({
      header,
      value: (row) => row.cells[index],
      width: table.widths[index] ?? undefined,
    }));

    return (
      <div className="flex items-center gap-2">
        <span className="text-muted-foreground text-sm">
          {table.rows.length === 1 ? '1 response' : `${table.rows.length} responses`},{' '}
          {table.headers.length} columns
        </span>
        <DataTableExportMenu
          rows={table.rows.map((cells) => ({ cells }))}
          config={{
            filename: table.filename,
            sheetName: table.sheetName,
            columns,
            timeZone: table.timeZone,
          }}
          scopeNote="Every response, with a column per question from the schema each one was answered against."
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col items-end gap-2">
      <Button variant="outline" size="sm" onClick={build} disabled={isPending || count === 0}>
        {isPending ? <Spinner /> : <Download />}
        {isPending ? 'Building…' : 'Prepare export'}
      </Button>
      {error && (
        <Alert variant="destructive" role="alert" className="max-w-md">
          <AlertTitle className="text-sm leading-relaxed font-normal">{error}</AlertTitle>
        </Alert>
      )}
    </div>
  );
}
