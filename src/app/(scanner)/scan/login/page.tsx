import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { ScanLine } from 'lucide-react';
import { getSessionUser } from '@/lib/auth/session';
import { safeRedirect } from '@/lib/auth/redirect-target';
import { OperatorLoginForm } from './login-form';

export const metadata: Metadata = { title: 'Door scanner — sign in' };

/**
 * Sign-in for the door.
 *
 * The session persists on the device, so an usher signs in once during setup
 * rather than at the door with a queue behind them (spec/checkin.md §12.1).
 */
export default async function ScannerLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;
  const user = await getSessionUser();
  if (user) redirect(safeRedirect(next ?? null, '/scan'));

  return (
    <main className="flex min-h-svh flex-col justify-center p-6">
      <div className="mx-auto w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center gap-3 text-center">
          <div className="bg-primary text-primary-foreground flex size-12 items-center justify-center rounded-xl">
            <ScanLine className="size-6" />
          </div>
          <div>
            <h1 className="text-xl font-semibold">Door scanner</h1>
            <p className="text-muted-foreground text-sm">
              Sign in once — this device stays signed in.
            </p>
          </div>
        </div>

        <OperatorLoginForm next={safeRedirect(next ?? null, '')} />
      </div>
    </main>
  );
}
