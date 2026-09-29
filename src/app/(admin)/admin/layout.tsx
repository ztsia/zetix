import type { Metadata } from 'next';
import { Eye } from 'lucide-react';
import { asc, isNull } from 'drizzle-orm';
import { requireRole } from '@/lib/auth/guards';
import { RoleProvider } from '@/components/auth/role';
import { getDb } from '@/db/client';
import { concerts } from '@/db/schema/concerts';
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar';
import { AppSidebar } from './app-sidebar';
import { BlastQueueBanner, BlastQueueProvider } from './blast-queue';
import { AdminHeader } from './header';
import { InlineScript } from '@/components/inline-script';
import { PRE_PAINT_SCRIPT } from './console-themes';
import { ConsoleThemeProvider } from './theme-provider';
import './themes.css';

export const metadata: Metadata = {
  title: { default: 'Admin — Zetix', template: '%s — Zetix' },
};

/**
 * The admin console shell (spec/surfaces.md §15.1).
 *
 * **This is where console authorization actually happens.** `requireRole()` reads
 * `app_users`, so it knows the role; `src/proxy.ts` only knows whether a session
 * cookie exists. An `ADMIN` and a `VIEWER` both pass (spec/v3.md §28); the role
 * is handed to the browser through `RoleProvider` so screens can hide what a
 * viewer may not do, and every action re-checks it on the server regardless.
 * Every page below this layout inherits the check, which is what makes
 * shipping an empty route skeleton safe.
 *
 * The concert list is loaded here rather than in the sidebar because a Client
 * Component cannot query the database, and the switcher needs the whole list
 * anyway. It is a handful of rows.
 *
 * **The shell owns one piece of cross-page state**: the email queue banner and
 * the dispatch loop behind it (spec/email.md §11.2.1, surfaces.md §15.1). They
 * are here because the loop has to outlive the screen that starts it — a blast
 * runs for about five minutes and an admin will navigate away inside that. The
 * backlog it reports is the concert in view's (spec/v3.md §24.5), read by the
 * concert layout on every render, which is what makes the banner survive a
 * reload rather than only a route change.
 */
export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await requireRole('ADMIN', 'VIEWER');

  const rows = await getDb()
    .select({ id: concerts.id, name: concerts.name, season: concerts.season })
    .from(concerts)
    .where(isNull(concerts.deletedAt))
    .orderBy(asc(concerts.startsOn), asc(concerts.name));

  return (
    <RoleProvider role={user.role}>
      {/* The console's theme, before it paints (spec/v3.md §29.5). */}
      <InlineScript html={PRE_PAINT_SCRIPT} />
      <ConsoleThemeProvider>
        <SidebarProvider>
          <AppSidebar concerts={rows} userLabel={user.displayName ?? user.email} />
          <SidebarInset>
            <BlastQueueProvider>
              <AdminHeader />
              {user.role === 'VIEWER' ? <ReadOnlyBanner /> : null}
              <BlastQueueBanner />
              <div className="flex flex-1 flex-col gap-4 p-4 md:p-6">{children}</div>
            </BlastQueueProvider>
          </SidebarInset>
        </SidebarProvider>
      </ConsoleThemeProvider>
    </RoleProvider>
  );
}

/**
 * Said once, in the shell, rather than on every screen: a viewer sees the same
 * console with contact details masked and without the controls that change
 * anything (spec/v3.md §28).
 */
function ReadOnlyBanner() {
  return (
    <div className="bg-muted text-muted-foreground flex items-center gap-2 border-b px-4 py-2 text-sm">
      <Eye className="size-4 shrink-0" />
      <span>
        <span className="text-foreground font-medium">Read-only access.</span> Email addresses
        and phone numbers are masked, and nothing can be changed, sent or exported from this
        account.
      </span>
    </div>
  );
}
