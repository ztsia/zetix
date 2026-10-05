'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Check, ChevronsUpDown, LayoutList, LogOut } from 'lucide-react';
import { BrandTile } from '@/components/brand/brand-tile';
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
import { ThemeSwitcher } from './theme-switcher';
import { AREAS, RECORD_ITEMS, SETTINGS_ITEM, areaHref, concertPath, locate } from './nav';

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
 * and every link below is relative to it: the seven areas of spec/v3.md §29.1,
 * then the concert's records. Outside a concert neither is rendered at all,
 * rather than rendered as links that go nowhere. The console-wide links —
 * every concert, Settings — sit in the footer.
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
  const inside = concertPath(pathname);
  const here = inside ? locate(inside.rest) : null;

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
                    <BrandTile className="size-8" glyphClassName="size-4" />
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
                      <Link href={`/admin/concerts/${option.id}/home`}>
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
        {base && (
          <SidebarGroup>
            <SidebarGroupContent>
              <SidebarMenu>
                {AREAS.map((area) => (
                  <SidebarMenuItem key={area.id}>
                    <SidebarMenuButton
                      isActive={here?.kind === 'area' && here.area.id === area.id}
                      tooltip={area.label}
                      render={<Link href={areaHref(concert!.id, area)} />}
                    >
                      <area.icon />
                      <span>{area.label}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )}
        {base && (
          // Global to the areas (§29.1): every area writes to the audit log
          // and the Trash, so neither belongs to one of them.
          <SidebarGroup className="mt-auto">
            <SidebarGroupLabel>Records</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {RECORD_ITEMS.map((item) => (
                  <SidebarMenuItem key={item.slug}>
                    <SidebarMenuButton
                      isActive={here?.kind === 'record' && here.item.slug === item.slug}
                      tooltip={item.label}
                      render={<Link href={`${base}/${item.slug}`} />}
                    >
                      <item.icon />
                      <span>{item.label}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )}
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              isActive={pathname === '/admin/concerts'}
              tooltip="All concerts"
              render={<Link href="/admin/concerts" />}
            >
              <LayoutList />
              <span>All concerts</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              isActive={pathname === '/admin/settings' || pathname.startsWith('/admin/settings/')}
              tooltip={SETTINGS_ITEM.label}
              render={<Link href="/admin/settings" />}
            >
              <SETTINGS_ITEM.icon />
              <span>{SETTINGS_ITEM.label}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <ThemeSwitcher />
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
