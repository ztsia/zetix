import type { Metadata } from 'next';
import { asc, isNull } from 'drizzle-orm';
import { requireAdmin } from '@/lib/auth/guards';
import { getDb } from '@/db/client';
import { concerts } from '@/db/schema/concerts';
import { outboxBacklog } from '@/lib/email/dispatch';
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar';
import { AppSidebar } from './app-sidebar';
import { BlastQueueBanner, BlastQueueProvider } from './blast-queue';
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
 *
 * **The shell owns one piece of cross-page state**: the email queue banner and
 * the dispatch loop behind it (spec/email.md §11.2.1, surfaces.md §15.1). They
 * are here because the loop has to outlive the screen that starts it — a blast
 * runs for about five minutes and an admin will navigate away inside that. The
 * backlog is read on every render, which is what makes the banner survive a
 * reload rather than only a route change.
 */
export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await requireAdmin();

  const [rows, backlog] = await Promise.all([
    getDb()
      .select({ id: concerts.id, name: concerts.name, season: concerts.season })
      .from(concerts)
      .where(isNull(concerts.deletedAt))
      .orderBy(asc(concerts.startsOn), asc(concerts.name)),
    outboxBacklog(),
  ]);

  return (
    <SidebarProvider>
      <AppSidebar concerts={rows} userLabel={user.displayName ?? user.email} />
      <SidebarInset>
        <BlastQueueProvider backlog={backlog}>
          <AdminHeader />
          <BlastQueueBanner />
          <div className="flex flex-1 flex-col gap-4 p-4 md:p-6">{children}</div>
        </BlastQueueProvider>
      </SidebarInset>
    </SidebarProvider>
  );
}
