import type { Metadata } from 'next';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { getDb } from '@/db/client';
import { systemSettings } from '@/db/schema/settings';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { SETTING_GROUPS } from './catalogue';
import { SettingRow } from './setting-row';

export const metadata: Metadata = { title: 'Settings' };

/**
 * `/admin/settings` — system defaults, the root of the cascade
 * (spec/admin.md §14.1, spec/README.md §2.2).
 *
 * Everything here is the **fallback**: a segment, show or concert that sets the
 * same key wins over it. That is worth stating on the screen, because the
 * failure mode is an admin changing a quota here, seeing nothing happen, and
 * concluding the setting is broken when in fact the segment overrides it.
 *
 * Two populations share the table and behave differently on a missing value
 * (spec/domain.md §6). System values are seeded at install, so resolution always
 * finds one. Operational values are **not** seeded — a missing one is a
 * validation error at save time, never a silent fallback — so they are listed
 * even when no row exists, and labelled as unset.
 */
export default async function SettingsPage() {
  const rows = await getDb()
    .select({ key: systemSettings.key, value: systemSettings.value })
    .from(systemSettings);

  const values = new Map(rows.map((row) => [row.key, row.value]));

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold">Settings</h1>
        <p className="text-muted-foreground text-sm">
          The root of the configuration cascade. A concert, show or segment that sets the
          same value overrides what is here.
        </p>
      </div>

      <Card>
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
          <div className="space-y-1">
            <h2 className="font-semibold">People</h2>
            <p className="text-muted-foreground text-sm">
              Who can sign in to this console, as an admin or a read-only viewer.
            </p>
          </div>
          <Button variant="outline" nativeButton={false} render={<Link href="/admin/settings/people" />}>
            Manage people
          </Button>
        </CardHeader>
      </Card>

      <Alert>
        <AlertTitle>Operational values have no default in code</AlertTitle>
        <AlertDescription>
          Capacities, quotas, deadlines and party caps ship with no value at any level.
          Setting one here makes it the fallback for every concert; leaving it unset means
          each segment or show must supply its own, and anything that has neither will
          refuse to allocate rather than guess.
        </AlertDescription>
      </Alert>

      {SETTING_GROUPS.map((group) => (
        <Card key={group.title}>
          <CardHeader className="gap-1">
            <h2 className="font-semibold">{group.title}</h2>
            <p className="text-muted-foreground text-sm">{group.blurb}</p>
          </CardHeader>
          <CardContent className="px-0">
            <div className="border-t">
              {group.settings.map((spec) => (
                <SettingRow
                  key={spec.key}
                  spec={spec}
                  // `undefined` — the key has no row — is meaningfully different
                  // from a stored `null`, so the map lookup is passed through
                  // rather than defaulted.
                  value={values.get(spec.key)}
                />
              ))}
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
