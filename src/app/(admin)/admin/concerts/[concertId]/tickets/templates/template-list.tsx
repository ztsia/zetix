'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { AlertTriangle, CheckCircle2, Copy, Pencil, Star, Trash2 } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ButtonGroup } from '@/components/ui/button-group';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { TemplateSummary } from '@/lib/tickets/templates';
import { DeleteButton } from '../../shows/delete-button';
import { deleteTemplateAction, duplicateTemplateAction, setDefaultTemplateAction } from './actions';
import { AdminOnly } from '@/components/auth/role';

/**
 * The template list (spec/tickets.md §10.3).
 *
 * A plain `Table`, not the shared `DataTable`. `DataTable` is for the six
 * screens that page through hundreds of rows and export them (CLAUDE.md
 * conventions); a concert has three or four templates and exporting them means
 * nothing. Reaching for it here would add sorting, filtering, pagination and an
 * export menu to a list that fits on one screen.
 */
export function TemplateList({
  concertId,
  templates,
}: {
  concertId: number;
  templates: TemplateSummary[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  const run = (action: () => Promise<{ ok: boolean } & Record<string, unknown>>) => {
    startTransition(async () => {
      const outcome = await action();
      setResult({
        ok: outcome.ok,
        text: String(outcome.ok ? outcome.message : outcome.error),
      });
      router.refresh();
    });
  };

  return (
    <div className="flex flex-col gap-4">
      {result && (
        <Alert variant={result.ok ? 'default' : 'destructive'}>
          {result.ok ? (
            <CheckCircle2 className="size-4" aria-hidden />
          ) : (
            <AlertTriangle className="size-4" aria-hidden />
          )}
          <AlertDescription>{result.text}</AlertDescription>
        </Alert>
      )}

      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Template</TableHead>
              <TableHead>Size</TableHead>
              <TableHead>Background</TableHead>
              <TableHead className="text-right">Elements</TableHead>
              <TableHead className="text-right">Issued</TableHead>
              <TableHead className="w-px" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {templates.map((template) => (
              <TableRow key={template.id}>
                <TableCell>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{template.name}</span>
                    <Badge variant="outline">v{template.version}</Badge>
                    {template.isDefault && (
                      <Badge className="gap-1">
                        <Star className="size-3" aria-hidden />
                        default
                      </Badge>
                    )}
                  </div>
                </TableCell>
                <TableCell className="text-muted-foreground text-sm">
                  {template.pageWidthPt} × {template.pageHeightPt} pt
                </TableCell>
                <TableCell className="text-muted-foreground text-sm">
                  {template.backgroundKind === 'NONE' ? 'none' : template.backgroundKind.toLowerCase()}
                </TableCell>
                <TableCell className="text-right tabular-nums">{template.elementCount}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {template.issuedCount > 0 ? (
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <span className="underline decoration-dotted underline-offset-4" />
                        }
                      >
                        {template.issuedCount}
                      </TooltipTrigger>
                      <TooltipContent>
                        Tickets are pinned to this version. Editing it saves a new one.
                      </TooltipContent>
                    </Tooltip>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell>
                  <ButtonGroup>
                    <Button
                      variant="outline"
                      size="sm"
                      // Not a native <button>; Base UI logs otherwise.
                      nativeButton={false}
                      render={
                        <Link
                          href={`/admin/concerts/${concertId}/tickets/templates/${template.id}`}
                        />
                      }
                    >
                      <Pencil />
                      Edit
                    </Button>
                    <AdminOnly>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={pending}
                        onClick={() =>
                          run(() => duplicateTemplateAction({ concertId, templateId: template.id }))
                        }
                      >
                        <Copy />
                        Duplicate
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={pending || template.isDefault}
                        onClick={() =>
                          run(() =>
                            setDefaultTemplateAction({ concertId, templateId: template.id }),
                          )
                        }
                      >
                        <Star />
                        Make default
                      </Button>
                    </AdminOnly>
                    {/*
                      `DeleteButton` keeps a refusal inside the dialog, which is
                      what this needs: "5 tickets are pinned to this version" is
                      not a failure to report and dismiss, it is the decision
                      the admin came here to make. Its `FormState` carries the
                      sentence verbatim, so the adapter below only reshapes the
                      result — it never rewrites the message.
                    */}
                    <DeleteButton
                      trigger={
                        <Button variant="outline" size="sm" className="text-destructive">
                          <Trash2 />
                          Delete
                        </Button>
                      }
                      title={`Delete ${template.name} v${template.version}?`}
                      description="The design is removed from this list. Tickets already issued are pinned to the version they were rendered with and are unaffected — a template any ticket is pinned to cannot be deleted at all."
                      confirmLabel="Delete template"
                      action={async () => {
                        const outcome = await deleteTemplateAction({
                          concertId,
                          templateId: template.id,
                        });
                        return {
                          error: outcome.ok ? null : String(outcome.error),
                          message: outcome.ok ? String(outcome.message ?? '') : null,
                        };
                      }}
                    />
                  </ButtonGroup>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
