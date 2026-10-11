import { Geist, Geist_Mono, Sora } from 'next/font/google';
import { cn } from '@/lib/utils';
import 'lenis/dist/lenis.css';
import './showcase.css';

/**
 * The landing page's own layout (spec/v3.md §31). Its faces, styles and Motion stay inside this
 * route group, so no other surface downloads them. Sora is the wordmark's face; the body stays the
 * root's Geist, plus its italic for the tempo markings and Geist Mono for codes and SQL.
 */
const display = Sora({ subsets: ['latin'], weight: ['600', '700'], variable: '--zx-font-display' });
const italic = Geist({ subsets: ['latin'], weight: ['400'], style: ['italic'], variable: '--zx-font-italic' });
const mono = Geist_Mono({ subsets: ['latin'], weight: ['400', '500'], variable: '--zx-font-mono' });

export default function ShowcaseLayout({ children }: { children: React.ReactNode }) {
  return <div className={cn(display.variable, italic.variable, mono.variable)}>{children}</div>;
}
