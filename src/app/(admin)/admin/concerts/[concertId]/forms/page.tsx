import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ExternalLink, Plus } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Empty, EmptyDescription, EmptyTitle } from '@/components/ui/empty';
import { Item, ItemActions, ItemContent, ItemDescription, ItemTitle } from '@/components/ui/item';
import { formatInZone } from '@/lib/export';
import { FormCreateDialog } from './form-create-dialog';
import { getConcertHeader, getFormParents, getFormsForConcert, type FormListRow } from './queries';

export const metadata: Metadata = { title: 'Forms' };

/**
 * `/admin/concerts/{id}/forms` — every form on the concert (spec/admin.md §14.1).
 *
 * Grouped by show, because a form's parent is what decides its rules: a
 * registration form belongs to a segment, whose audience, capacity and caps it
 * inherits, and a feedback form belongs to the show itself. Listing them flat
 * would hide the one fact that explains the rest.
 *
 * Rounds sit together under their segment. A second round is a new form
 * (`domain.md` §5.1), so an admin who expects to find one form per segment and
 * finds two needs the round label next to the title rather than in a detail
 * pane.
 */

const STATUS_VARIANT: Record<FormListRow['status'], 'default' | 'secondary' | 'outline'> = {
  OPEN: 'default',
  DRAFT: 'secondary',
  CLOSED: 'outline',
};

const KIND_LABEL: Record<FormListRow['kind'], string> = {
  PLAYER: 'Player',
  PUBLIC: 'Public',
  FEEDBACK: 'Feedback',
};

export default async function FormsPage({
  params,
}: {
  params: Promise<{ concertId: string }>;
}) {
  const { concertId: raw } = await params;
  const concertId = Number(raw);
  if (!Number.isInteger(concertId) || concertId <= 0) notFound();

  const concert = await getConcertHeader(concertId);
  if (!concert) notFound();

  const [forms, parents] = await Promise.all([
    getFormsForConcert(concertId),
    getFormParents(concertId),
  ]);

  const byShow = new Map<number, { name: string; forms: FormListRow[] }>();
  for (const form of forms) {
    const entry = byShow.get(form.showId) ?? { name: form.showName, forms: [] };
    entry.forms.push(form);
    byShow.set(form.showId, entry);
  }

  const zone = concert.timezone ?? 'UTC';

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">Forms</h1>
          <p className="text-muted-foreground text-sm">
            Registration and feedback forms, their questions and their responses.
          </p>
        </div>
        <FormCreateDialog
          concertId={concertId}
          parents={parents}
          trigger={
            <Button>
              <Plus />
              New form
            </Button>
          }
        />
      </div>

      {forms.length === 0 && (
        <Empty>
          <EmptyTitle>No forms yet</EmptyTitle>
          <EmptyDescription>
            A form&rsquo;s questions come from its kind, so there is nothing to map and
            nothing to wire up — choose player, public or feedback and edit the wording.
          </EmptyDescription>
        </Empty>
      )}

      {[...byShow.entries()].map(([showId, group]) => (
        <Card key={showId}>
          <CardHeader>
            <CardTitle className="text-base">{group.name}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            {group.forms.map((form) => (
              <Item key={form.id} variant="outline" className="flex-wrap">
                <ItemContent>
                  <ItemTitle className="flex flex-wrap items-center gap-2">
                    <Link
                      href={`/admin/concerts/${concertId}/forms/${form.id}`}
                      className="font-medium underline-offset-4 hover:underline"
                    >
                      {form.title}
                    </Link>
                    {form.roundLabel && <Badge variant="outline">{form.roundLabel}</Badge>}
                    <Badge variant="secondary">{KIND_LABEL[form.kind]}</Badge>
                    <Badge variant={STATUS_VARIANT[form.status]}>
                      {form.status.toLowerCase()}
                    </Badge>
                  </ItemTitle>
                  <ItemDescription>
                    {form.segmentName ? `${form.segmentName} · ` : ''}
                    /f/{form.slug} · v{form.schemaVersion} ·{' '}
                    {form.responses === 1 ? '1 response' : `${form.responses} responses`}
                    {form.opensAt && ` · opens ${formatInZone(form.opensAt, zone)}`}
                    {form.closesAt && ` · closes ${formatInZone(form.closesAt, zone)}`}
                  </ItemDescription>
                </ItemContent>

                <ItemActions>
                  {form.status === 'OPEN' && (
                    <Button variant="ghost" size="sm" render={<a href={`/f/${form.slug}`} target="_blank" rel="noreferrer" />}>
                      <ExternalLink />
                      Open
                    </Button>
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    render={<Link href={`/admin/concerts/${concertId}/forms/${form.id}`} />}
                  >
                    Edit
                  </Button>
                </ItemActions>
              </Item>
            ))}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
