'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Check, ChevronsUpDown, LogOut, Music4, Settings } from 'lucide-react';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from '@/components/ui/sidebar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { signOut } from '@/lib/auth/actions';
import { CONCERT_NAV, SETTINGS_ITEM } from './nav';

export type ConcertSummary = { id: number; name: string; season: string | null };

/**
 * Which concert the current URL is inside.
 *
 * The active concert is derived from the path rather than held in React state or
 * a cookie, so a bookmarked or shared link to a screen deep inside one concert
 * opens in that concert. State would make the same URL mean different things to
 * two people.
 */
export function activeConcertId(pathname: string): number | null {
  const match = /^\/admin\/concerts\/(\d+)(?:\/|$)/.exec(pathname);
  return match ? Number(match[1]) : null;
}

/**
 * The admin sidebar (spec/surfaces.md §15.1).
 *
 * A concert is selected once and held in context, so its name heads the sidebar
 * and every nav link below is relative to it. Outside a concert the per-concert
 * groups are not rendered at all, rather than rendered as links that go nowhere.
 */
export function AppSidebar({
  concerts,
  userLabel,
}: {
  concerts: ConcertSummary[];
  userLabel: string;
}) {
  const pathname = usePathname();
  const currentId = activeConcertId(pathname);
  const concert = concerts.find((c) => c.id === currentId) ?? null;
  const base = concert ? `/admin/concerts/${concert.id}` : null;

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <SidebarMenuButton
                    size="lg"
                    className="data-[popup-open]:bg-sidebar-accent"
                  >
                    <div className="bg-primary text-primary-foreground flex aspect-square size-8 items-center justify-center rounded-lg">
                      <Music4 className="size-4" />
                    </div>
                    <div className="grid flex-1 text-left leading-tight">
                      <span className="truncate font-medium">
                        {concert?.name ?? 'Zetix'}
                      </span>
                      <span className="text-muted-foreground truncate text-xs">
                        {concert?.season ?? 'No concert selected'}
                      </span>
                    </div>
                    <ChevronsUpDown className="ml-auto size-4" />
                  </SidebarMenuButton>
                }
              />
              <DropdownMenuContent align="start" className="w-56">
                {/* Wrapped: Base UI's GroupLabel throws outside a Group. */}
                <DropdownMenuGroup>
                <DropdownMenuLabel>Concerts</DropdownMenuLabel>
                <DropdownMenuSeparator />
                {concerts.length === 0 && (
                  <DropdownMenuItem disabled>No concerts yet</DropdownMenuItem>
                )}
                {concerts.map((option) => (
                  <DropdownMenuItem
                    key={option.id}
                    render={
                      <Link href={`/admin/concerts/${option.id}/overview`}>
                        <span className="flex-1 truncate">{option.name}</span>
                        {option.id === concert?.id && <Check className="size-4" />}
                      </Link>
                    }
                  />
                ))}
                <DropdownMenuSeparator />
                <DropdownMenuItem render={<Link href="/admin/concerts">All concerts</Link>} />
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        {base &&
          CONCERT_NAV.map((group) => (
            // Tightened so all fourteen screens of admin.md §14.1 fit a 720px
            // laptop without scrolling. It still scrolls if a later module adds
            // rows, but nothing in the shipped set is hidden on open.
            <SidebarGroup key={group.label || 'top'} className="py-0.5">
              {group.label && (
                <SidebarGroupLabel className="h-6">{group.label}</SidebarGroupLabel>
              )}
              <SidebarGroupContent>
                <SidebarMenu>
                  {group.items.map((item) => {
                    const href = `${base}/${item.slug}`;
                    return (
                      <SidebarMenuItem key={item.slug}>
                        <SidebarMenuButton
                          isActive={pathname === href || pathname.startsWith(`${href}/`)}
                          tooltip={item.label}
                          render={<Link href={href} />}
                        >
                          <item.icon />
                          <span>{item.label}</span>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    );
                  })}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          ))}
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              isActive={pathname === '/admin/settings'}
              tooltip={SETTINGS_ITEM.label}
              render={<Link href="/admin/settings" />}
            >
              <Settings />
              <span>{SETTINGS_ITEM.label}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <form action={signOut}>
              <SidebarMenuButton
                type="submit"
                tooltip={`Signed in as ${userLabel} — sign out`}
                className="w-full"
              >
                <LogOut />
                <span>Sign out</span>
              </SidebarMenuButton>
            </form>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
