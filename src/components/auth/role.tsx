'use client';

import { createContext, useContext } from 'react';
import type { Role } from '@/lib/auth/session';

/**
 * The signed-in console user's role, for the browser (spec/v3.md §28).
 *
 * **This decides what is shown, never what is allowed.** Every Server Action
 * and Route Handler re-checks the role on the server; hiding a button from a
 * viewer only spares them a button that would refuse them. So a component that
 * forgets to ask is untidy, not unsafe.
 *
 * Provided once by the admin layout. Outside it — a test rendering a screen on
 * its own — the answer is `ADMIN`, the role every screen was written for.
 */
const RoleContext = createContext<Role>('ADMIN');

export function RoleProvider({ role, children }: { role: Role; children: React.ReactNode }) {
  return <RoleContext.Provider value={role}>{children}</RoleContext.Provider>;
}

export function useRole(): Role {
  return useContext(RoleContext);
}

/** Whether this user may change anything — every role but `VIEWER` in the console. */
export function useCanEdit(): boolean {
  return useRole() === 'ADMIN';
}

/** Renders its children for an admin only: the wrapper for a screen's mutating controls. */
export function AdminOnly({
  children,
  fallback = null,
}: {
  children: React.ReactNode;
  fallback?: React.ReactNode;
}) {
  return useCanEdit() ? children : fallback;
}
