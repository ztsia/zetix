'use client';

import { Monitor, Moon, Palette, Sun } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { SidebarMenuButton } from '@/components/ui/sidebar';
import { cn } from '@/lib/utils';
import { CONSOLE_MODES, CONSOLE_THEMES, isMode, isThemeId } from './console-themes';
import { useConsoleTheme } from './theme-provider';

const MODE_ICON = { light: Sun, dark: Moon, system: Monitor } as const;

/**
 * Appearance: the mode and the colour theme (spec/v3.md §29.5), in the
 * sidebar's footer beside Settings.
 *
 * A menu of two radio groups rather than a settings page: it is a personal
 * preference for this browser, so it should be one click away and try out
 * live — choosing an item applies it without closing the menu. Each theme
 * shows its own colours in its current mode, drawn by `.theme-swatch`, so the
 * list can be read without trying every entry. A viewer may change it: it
 * changes nothing anyone else sees.
 */
export function ThemeSwitcher() {
  const { theme, mode, dark, setTheme, setMode } = useConsoleTheme();
  const current = CONSOLE_THEMES.find((entry) => entry.id === theme)?.label ?? 'Default';

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <SidebarMenuButton tooltip={`Appearance: ${current}, ${mode}`} className="data-[popup-open]:bg-sidebar-accent">
            <Palette />
            <span>Appearance</span>
          </SidebarMenuButton>
        }
      />
      <DropdownMenuContent side="right" align="end" className="w-60">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Mode</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={mode} onValueChange={(value) => isMode(value) && setMode(value)}>
            {CONSOLE_MODES.map((entry) => {
              const Icon = MODE_ICON[entry.id];
              return (
                <DropdownMenuRadioItem key={entry.id} value={entry.id} closeOnClick={false}>
                  <Icon />
                  {entry.label}
                </DropdownMenuRadioItem>
              );
            })}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuLabel>Theme</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={theme} onValueChange={(value) => isThemeId(value) && setTheme(value)}>
            {CONSOLE_THEMES.map((entry) => (
              <DropdownMenuRadioItem key={entry.id} value={entry.id} closeOnClick={false}>
                <span
                  aria-hidden
                  data-theme={entry.id}
                  className={cn(
                    'theme-swatch bg-background flex h-5 w-9 shrink-0 items-center justify-center gap-0.5 rounded-sm border',
                    dark && 'dark',
                  )}
                >
                  <span className="bg-primary size-2.5 rounded-full" />
                  <span className="bg-secondary size-2.5 rounded-full border" />
                  <span className="bg-foreground size-2.5 rounded-full" />
                </span>
                {entry.label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
