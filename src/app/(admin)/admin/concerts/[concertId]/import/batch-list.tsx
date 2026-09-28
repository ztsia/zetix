import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Item, ItemActions, ItemContent, ItemDescription, ItemTitle } from '@/components/ui/item';
import { Button } from '@/components/ui/button';
import type { BatchListRow } from '@/lib/import/staging-queries';

const STATUS: Record<BatchListRow['status'], { label: string; variant: 'default' | 'secondary' | 'outline' }> = {
  STAGED: { label: 'staged', variant: 'default' },
  COMMITTED: { label: 'committed', variant: 'secondary' },
  UNDONE: { label: 'undone', variant: 'outline' },
  DRY_RUN: { label: 'dry run', variant: 'outline' },
};

/**
 * Imports already started (spec/v3.md §25.7): a staged batch is committed in
 * as many passes as it takes, so it has to be findable again.
 */
export function BatchList({
  concertId,
  batches,
  timeZone,
}: {
  concertId: number;
  batches: BatchListRow[];
  timeZone: string;
}) {
  const format = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone });
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Imports</CardTitle>
        <CardDescription>Open one to fix and commit what is still staged, or to undo it.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {batches.map((batch) => (
          <Item key={batch.id} variant="outline">
            <ItemContent>
              <ItemTitle>
                {batch.filename}
                <Badge variant={STATUS[batch.status].variant}>{STATUS[batch.status].label}</Badge>
              </ItemTitle>
              <ItemDescription>
                {batch.segmentLabel} · {format.format(new Date(batch.createdAt))} · {batch.committed} committed
                {batch.staged > 0 ? `, ${batch.staged} still staged` : ''}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <Button
                size="sm"
                variant="outline"
                nativeButton={false}
                render={<Link href={`/admin/concerts/${concertId}/import/${batch.id}`} />}
              >
                Open
              </Button>
            </ItemActions>
          </Item>
        ))}
      </CardContent>
    </Card>
  );
}
