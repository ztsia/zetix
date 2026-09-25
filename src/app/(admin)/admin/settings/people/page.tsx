import type { Metadata } from 'next';
import { desc, isNull } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { concerts } from '@/db/schema/concerts';
import { requireRole } from '@/lib/auth/guards';
import { maskForRole } from '@/lib/auth/mask';
import { listConsoleAccounts } from '@/lib/people/provision';
import { PeopleScreen, type PersonRow } from './people-screen';

export const metadata: Metadata = { title: 'People' };

/**
 * `/admin/settings/people` — named console accounts (spec/v3.md §28).
 *
 * A viewer may read it, like every admin screen, with the addresses masked; the
 * actions refuse them and the screen offers them none.
 */
export default async function PeoplePage() {
  const user = await requireRole('ADMIN', 'VIEWER');

  const [accounts, [latest]] = await Promise.all([
    listConsoleAccounts(),
    // Timestamps render in a concert's zone, never the viewer's (`CLAUDE.md`).
    // This screen belongs to no concert, so it borrows the newest one's.
    getDb()
      .select({ timezone: concerts.timezone })
      .from(concerts)
      .where(isNull(concerts.deletedAt))
      .orderBy(desc(concerts.startsOn))
      .limit(1),
  ]);

  const people: PersonRow[] = accounts.map((account) => ({
    id: account.id,
    email: account.email,
    displayName: account.displayName,
    role: account.role,
    isActive: account.isActive,
    lastLoginAt: account.lastLoginAt?.toISOString() ?? null,
    isYou: account.id === user.id,
  }));

  return (
    <PeopleScreen people={maskForRole(user.role, people)} timeZone={latest?.timezone ?? 'UTC'} />
  );
}
