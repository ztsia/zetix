import type { Metadata } from 'next';
import { asc, isNull } from 'drizzle-orm';
import { requireAdmin } from '@/lib/auth/guards';
import { getDb } from '@/db/client';
import { concerts } from '@/db/schema/concerts';
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar';
import { AppSidebar } from './app-sidebar';
import { AdminHeader } from './header';

export const metadata: Metadata = {
  title: { default: 'Admin — Zetix', template: '%s — Zetix' },
};

/**
 * The admin console shell (spec/surfaces.md §15.1).
 *
 * **This is where admin authorization actually happens.** `requireAdmin()` reads
 * `app_users`, so it knows the role; `src/proxy.ts` only knows whether a session
 * cookie exists. Every page below this layout inherits the check, which is what
 * makes shipping an empty route skeleton safe.
 *
 * The concert list is loaded here rather than in the sidebar because a Client
 * Component cannot query the database, and the switcher needs the whole list
 * anyway. It is a handful of rows.
 */
export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await requireAdmin();

  const rows = await getDb()
    .select({ id: concerts.id, name: concerts.name, season: concerts.season })
    .from(concerts)
    .where(isNull(concerts.deletedAt))
    .orderBy(asc(concerts.startsOn), asc(concerts.name));

  return (
    <SidebarProvider>
      <AppSidebar concerts={rows} userLabel={user.displayName ?? user.email} />
      <SidebarInset>
        <AdminHeader />
        <div className="flex flex-1 flex-col gap-4 p-4 md:p-6">{children}</div>
      </SidebarInset>
    </SidebarProvider>
  );
}
