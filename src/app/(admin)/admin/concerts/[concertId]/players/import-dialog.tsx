'use client';

import { useRef, useState, useTransition, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { Upload } from 'lucide-react';
import { Alert, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Spinner } from '@/components/ui/spinner';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { PlayerField, PlayerImportPlan } from '@/lib/players/import';
import { commitPlayerImportAction, planPlayerImportAction } from './actions';

const FIELD_LABEL: Record<PlayerField, string> = {
  fullName: 'Name',
  email: 'Email',
  instrument: 'Instrument',
  section: 'Section',
};

/**
 * CSV import for players — upload, map, dry run, commit.
 *
 * **The dry run is the point, not a nicety.** Importing ~80 players is the step
 * where a wrong column silently produces eighty people called "Violin", and the
 * only cheap moment to catch it is before the write. So the screen shows the
 * mapping it guessed, lets the admin correct it, and lists what every row would
 * do before anything happens.
 *
 * The file is posted twice — once to plan, once to commit — and the server
 * re-parses it both times. Posting the plan back instead would mean trusting
 * rows that have been through the browser, which is how an import writes
 * something the preview never showed.
 */
export function PlayerImportDialog({
  concertId,
  trigger,
}: {
  concertId: number;
  trigger: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [plan, setPlan] = useState<PlayerImportPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const formRef = useRef<HTMLFormElement>(null);
  const router = useRouter();

  function reset() {
    setPlan(null);
    setError(null);
  }

  function preview() {
    const form = formRef.current;
    if (!form) return;
    const formData = new FormData(form);
    setError(null);
    startTransition(async () => {
      const result = await planPlayerImportAction(concertId, formData);
      if (!result.ok) {
        setPlan(null);
        setError(result.error);
        return;
      }
      setPlan(result.plan);
    });
  }

  function commit() {
    const form = formRef.current;
    if (!form) return;
    const formData = new FormData(form);
    setError(null);
    startTransition(async () => {
      const result = await commitPlayerImportAction(concertId, formData);
      if (result.error) {
        setError(result.error);
        return;
      }
      setOpen(false);
      reset();
      router.refresh();
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next: boolean) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger render={trigger as React.ReactElement} />

      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Import players</DialogTitle>
          <DialogDescription>
            A CSV or spreadsheet, one player per row. Nothing is written until you
            commit.
          </DialogDescription>
        </DialogHeader>

        <form ref={formRef} className="flex flex-col gap-4">
          <Field>
            <FieldLabel htmlFor="player-import-file">File</FieldLabel>
            <Input
              id="player-import-file"
              name="file"
              type="file"
              accept=".csv,.xlsx,text/csv"
              onChange={reset}
            />
            <FieldDescription>
              The first sheet is used, and the header row is detected automatically.
            </FieldDescription>
          </Field>

          {plan && (
            <>
              <div className="grid gap-3 sm:grid-cols-2">
                {(Object.keys(FIELD_LABEL) as PlayerField[]).map((field) => (
                  <Field key={field}>
                    <FieldLabel htmlFor={`map-${field}`}>{FIELD_LABEL[field]}</FieldLabel>
                    <NativeSelect
                      id={`map-${field}`}
                      name={`map-${field}`}
                      defaultValue={plan.mapping[field] ?? ''}
                      onChange={preview}
                    >
                      <option value="">— not imported —</option>
                      {plan.headers.map((header) => (
                        <option key={header} value={header}>
                          {header}
                        </option>
                      ))}
                    </NativeSelect>
                  </Field>
                ))}
              </div>

              <div className="flex flex-wrap items-center gap-2 text-sm">
                <Badge>{plan.counts.create} to add</Badge>
                {plan.counts.update > 0 && (
                  <Badge variant="secondary">{plan.counts.update} to update</Badge>
                )}
                {plan.counts.skip > 0 && (
                  <Badge variant="outline">{plan.counts.skip} skipped</Badge>
                )}
              </div>

              <ScrollArea className="h-64 rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-16">Row</TableHead>
                      <TableHead>Name</TableHead>
                      <TableHead>Email</TableHead>
                      <TableHead>Instrument</TableHead>
                      <TableHead>Section</TableHead>
                      <TableHead>Action</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {plan.rows.map((row) => (
                      <TableRow
                        key={row.rowNumber}
                        className={row.action === 'skip' ? 'text-muted-foreground' : ''}
                      >
                        <TableCell className="tabular-nums">{row.rowNumber}</TableCell>
                        <TableCell>{row.fullName || '—'}</TableCell>
                        <TableCell>{row.email ?? '—'}</TableCell>
                        <TableCell>{row.instrument ?? '—'}</TableCell>
                        <TableCell>{row.section ?? '—'}</TableCell>
                        <TableCell>
                          {row.action === 'skip' ? (
                            // The reason travels with the row, so the admin can
                            // fix the file rather than guess which eight of
                            // eighty rows were dropped.
                            <span className="text-xs">{row.reason}</span>
                          ) : (
                            <Badge
                              variant={row.action === 'create' ? 'default' : 'secondary'}
                            >
                              {row.action === 'create' ? 'add' : 'update'}
                            </Badge>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </ScrollArea>
            </>
          )}

          {error && (
            <Alert variant="destructive" role="alert">
              {/* The base-entitlement guard can refuse the whole import, naming
                  the segment and the shortfall (spec/allocation.md §7.4). */}
              <AlertTitle className="text-sm leading-relaxed font-normal whitespace-pre-wrap">
                {error}
              </AlertTitle>
            </Alert>
          )}
        </form>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={isPending}
            onClick={() => setOpen(false)}
          >
            Cancel
          </Button>
          {plan ? (
            <Button type="button" onClick={commit} disabled={isPending}>
              {isPending && <Spinner />}
              Import {plan.counts.create + plan.counts.update} player
              {plan.counts.create + plan.counts.update === 1 ? '' : 's'}
            </Button>
          ) : (
            <Button type="button" onClick={preview} disabled={isPending}>
              {isPending ? <Spinner /> : <Upload />}
              {isPending ? 'Reading…' : 'Preview'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
