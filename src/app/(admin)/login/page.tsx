import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Music4 } from 'lucide-react';
import { getSessionUser } from '@/lib/auth/session';
import { safeRedirect } from '@/lib/auth/redirect-target';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { AdminLoginForm } from './login-form';

export const metadata: Metadata = { title: 'Sign in — Zetix' };

/**
 * The admin console's front door.
 *
 * It sits outside `/admin`, so the guard in that layout does not apply and there
 * is no redirect loop. The proxy deliberately does not bounce a signed-in
 * visitor away from here, because it cannot tell an admin from an operator — the
 * role is known on this side, so the decision is made here.
 */
export default async function AdminLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;
  const user = await getSessionUser();

  if (user?.role === 'ADMIN') redirect(safeRedirect(next ?? null, '/admin'));
  // An operator who lands here is already signed in; the admin code would not
  // change their role, so send them to the surface they do have.
  if (user?.role === 'OPERATOR') redirect('/scan');

  return (
    <main className="flex min-h-svh items-center justify-center p-6">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center gap-2 text-center">
          <div className="bg-primary text-primary-foreground flex size-10 items-center justify-center rounded-lg">
            <Music4 className="size-5" />
          </div>
          <h1 className="text-lg font-semibold">Zetix</h1>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Admin sign-in</CardTitle>
            <CardDescription>
              Enter the shared committee code to reach the console.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <AdminLoginForm next={safeRedirect(next ?? null, '')} />
          </CardContent>
        </Card>

        <p className="text-muted-foreground mt-6 text-center text-xs">
          Ushers sign in at{' '}
          <Link href="/scan/login" className="underline underline-offset-4">
            the door scanner
          </Link>
          .
        </p>
      </div>
    </main>
  );
}
