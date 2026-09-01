import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Zetix',
  // Every tokenised surface is noindex (spec.md §13.3, ref.md §7).
  robots: { index: false, follow: false },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="antialiased">{children}</body>
    </html>
  );
}
