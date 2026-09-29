import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { requireRole } from '@/lib/auth/guards';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { SETTING_GROUPS } from '../../../settings/catalogue';
import { SettingRow } from '../../../settings/setting-row';
import { CONCERT_COLUMNS } from './columns';
import { ConcertForm, type ConcertFields } from './concert-form';

export const metadata: Metadata = { title: 'Setup' };

/**
 * `/admin/concerts/{id}/setup` — Setup › Concert (spec/v3.md §29.1): the
 * concert itself, and its level of the configuration cascade.
 *
 * The cascade's concert level had no screen before V3: a value could be set
 * for every concert (Settings) or per show and segment (Shows), but not for
 * one concert. Only keys the code reads with a concert in hand are listed
 * (`SettingSpec.concert`) — a concert value for a key read without one would
 * be a control that does nothing.
 *
 * Nothing here is contact data, so a viewer is handed the same props as an
 * admin; the form disables itself and every Save is `AdminOnly`.
 */
export default async function SetupConcertPage({
  params,
}: {
  params: Promise<{ concertId: string }>;
}) {
  await requireRole('ADMIN', 'VIEWER');
  const { concertId: raw } = await params;
  const concertId = Number(raw);
  if (!Number.isInteger(concertId) || concertId <= 0) notFound();

  const db = getDb();
  const [row] = await db.execute<{
    id: string;
    name: string;
    slug: string;
    season: string | null;
    timezone: string | null;
    starts_on: string | null;
    ends_on: string | null;
    status: ConcertFields['status'];
    defaults: Record<string, unknown> | null;
    columns: Record<string, unknown>;
  }>(sql`
    select id, name, slug, season, timezone, starts_on::text, ends_on::text, status::text as status,
           defaults,
           jsonb_build_object(
             ${sql.join(
               Object.entries(CONCERT_COLUMNS).map(([key, column]) => sql`${key}::text, to_jsonb(${sql.raw(column)})`),
               sql`, `,
             )}
           ) as columns
      from concerts where id = ${concertId} and deleted_at is null`);
  if (!row) notFound();

  const system = await db.execute<{ key: string; value: unknown }>(sql`select key, value from system_settings`);
  const systemValues = new Map(system.map((entry) => [entry.key, entry.value]));

  const concertValue = (key: string): unknown =>
    key in CONCERT_COLUMNS ? (row.columns[key] ?? null) : (row.defaults?.[key] ?? null);

  const groups = SETTING_GROUPS.map((group) => ({
    ...group,
    settings: group.settings.filter((spec) => spec.concert),
  })).filter((group) => group.settings.length > 0);

  const concert: ConcertFields = {
    id: Number(row.id),
    name: row.name,
    slug: row.slug,
    season: row.season,
    timezone: row.timezone,
    startsOn: row.starts_on,
    endsOn: row.ends_on,
    status: row.status,
  };

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold">Concert</h1>
        <p className="text-muted-foreground text-sm">
          The concert itself, and the values every show and segment in it inherits unless they set
          their own.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{concert.name}</CardTitle>
          <CardDescription>Name, dates and the zone every time is shown in.</CardDescription>
        </CardHeader>
        <CardContent>
          <ConcertForm concert={concert} />
        </CardContent>
      </Card>

      {groups.map((group) => (
        <Card key={group.title}>
          <CardHeader>
            <CardTitle>{group.title}</CardTitle>
            <CardDescription>
              For this concert only. A show or segment that sets the same value overrides it; one
              left empty here inherits from Settings.
            </CardDescription>
          </CardHeader>
          <CardContent className="px-0">
            <div className="border-t">
              {group.settings.map((spec) => (
                <SettingRow
                  key={spec.key}
                  spec={spec}
                  value={concertValue(spec.key)}
                  concert={{ id: concert.id, inherited: systemValues.get(spec.key) ?? null }}
                />
              ))}
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
