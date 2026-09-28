import type { CSSProperties, ReactNode } from 'react';
import { themeTokens, type FormTheme } from '@/lib/forms/theme';

/**
 * A form screen under its theme (spec/v3.md §25.6): the banner above the
 * header card, as Google Forms draws it, and the theme's `--form-*` tokens set
 * on this wrapper — nothing else. With no theme it is a plain wrapper and the
 * form keeps the site's look.
 */
export function ThemedForm({
  theme,
  bannerSrc,
  children,
}: {
  theme: FormTheme | null;
  bannerSrc: string | null;
  children: ReactNode;
}) {
  const tokens = themeTokens(theme);
  return (
    <div data-slot="themed-form" className="flex flex-col gap-3" style={(tokens ?? undefined) as CSSProperties | undefined}>
      {bannerSrc ? (
        // eslint-disable-next-line @next/next/no-img-element -- a stored upload, sized by CSS
        <img src={bannerSrc} alt="" className="aspect-[4/1] w-full rounded-lg object-cover" />
      ) : null}
      {children}
    </div>
  );
}
