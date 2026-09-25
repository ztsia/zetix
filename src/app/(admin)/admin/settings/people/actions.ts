'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { dbErrorMessage } from '@/db/errors';
import { requireRole } from '@/lib/auth/guards';
import { createAuthAdmin } from '@/lib/operators/auth-admin';
import {
  CONSOLE_ROLES,
  PeopleProvisionError,
  createConsoleAccount,
  renameConsoleAccount,
  resetConsolePassword,
  setConsoleActive,
  setConsoleRole,
} from '@/lib/people/provision';
import type { PeopleFormState } from './form-state';

/**
 * Settings › People (spec/v3.md §28).
 *
 * **Every action is `requireRole('ADMIN')`.** Provisioning is the most
 * privileged thing the console does — it mints the credentials that reach it —
 * so a viewer reads this screen and changes nothing on it.
 *
 * The service-role client is built inside the guard, never above it, as on the
 * Operators screen: it bypasses RLS entirely.
 */

const PATH = '/admin/settings/people';

const displayNameSchema = z
  .string()
  .trim()
  .min(1, 'Give the account a name — it is what the Activity log shows.')
  .max(120, 'That name is too long.');
const emailSchema = z
  .string()
  .trim()
  .min(1, 'Enter an email address.')
  // RFC 5321's limit on a whole address — a protocol bound, not an operational value.
  .max(254, 'That email address is too long.')
  .email('Enter a valid email address.');
const roleSchema = z
  .enum(CONSOLE_ROLES as [string, ...string[]], { error: 'Choose Admin or Viewer.' })
  .transform((r) => r as 'ADMIN' | 'VIEWER');
const userIdSchema = z.string().uuid('Malformed request.');

function authAdmin() {
  return createAuthAdmin({ noun: 'account', secret: 'password' });
}

function toFormError(error: unknown): PeopleFormState {
  if (error instanceof PeopleProvisionError) return { error: error.message };
  if (error instanceof Error && error.message.includes('SUPABASE_SERVICE_ROLE_KEY')) {
    return {
      error:
        'This needs the Supabase service-role key, which this deployment does not hold ' +
        '(docs/local.md §5b).',
    };
  }
  return { error: dbErrorMessage(error) };
}

export async function createAccountAction(
  _prev: PeopleFormState,
  formData: FormData,
): Promise<PeopleFormState> {
  const admin = await requireRole('ADMIN');

  const parsed = z
    .object({ email: emailSchema, displayName: displayNameSchema, role: roleSchema })
    .safeParse({
      email: formData.get('email') ?? '',
      displayName: formData.get('displayName') ?? '',
      role: formData.get('role') ?? '',
    });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Check the form and try again.' };
  }

  try {
    const created = await createConsoleAccount({ ...parsed.data, actorId: admin.id }, authAdmin());
    revalidatePath(PATH);
    return {
      error: null,
      message: `Created ${created.displayName}.`,
      issued: { displayName: created.displayName, email: created.email, password: created.password },
    };
  } catch (error) {
    return toFormError(error);
  }
}

export async function resetPasswordAction(userId: string): Promise<PeopleFormState> {
  const admin = await requireRole('ADMIN');
  const parsed = userIdSchema.safeParse(userId);
  if (!parsed.success) return { error: 'Malformed request.' };

  try {
    const reset = await resetConsolePassword({ userId: parsed.data, actorId: admin.id }, authAdmin());
    revalidatePath(PATH);
    return {
      error: null,
      message: `Issued a new password for ${reset.displayName}.`,
      issued: { displayName: reset.displayName, email: '', password: reset.password },
    };
  } catch (error) {
    return toFormError(error);
  }
}

export async function setRoleAction(userId: string, role: string): Promise<PeopleFormState> {
  const admin = await requireRole('ADMIN');
  const parsed = z.object({ userId: userIdSchema, role: roleSchema }).safeParse({ userId, role });
  if (!parsed.success) return { error: 'Malformed request.' };

  try {
    await setConsoleRole({ ...parsed.data, actorId: admin.id });
    revalidatePath(PATH);
    return {
      error: null,
      message:
        parsed.data.role === 'ADMIN'
          ? 'Now an admin. It takes effect on their next page load.'
          : 'Now a viewer. It takes effect on their next page load.',
    };
  } catch (error) {
    return toFormError(error);
  }
}

export async function setActiveAction(userId: string, isActive: boolean): Promise<PeopleFormState> {
  const admin = await requireRole('ADMIN');
  const parsed = z.object({ userId: userIdSchema, isActive: z.boolean() }).safeParse({ userId, isActive });
  if (!parsed.success) return { error: 'Malformed request.' };

  try {
    await setConsoleActive({ ...parsed.data, actorId: admin.id });
    revalidatePath(PATH);
    return {
      error: null,
      message: parsed.data.isActive
        ? 'They can sign in again.'
        : 'Deactivated. Their session stops working on their next request.',
    };
  } catch (error) {
    return toFormError(error);
  }
}

export async function renameAccountAction(
  _prev: PeopleFormState,
  formData: FormData,
): Promise<PeopleFormState> {
  const admin = await requireRole('ADMIN');
  const parsed = z
    .object({ userId: userIdSchema, displayName: displayNameSchema })
    .safeParse({ userId: formData.get('userId') ?? '', displayName: formData.get('displayName') ?? '' });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Check the form and try again.' };
  }

  try {
    await renameConsoleAccount({ ...parsed.data, actorId: admin.id });
    revalidatePath(PATH);
    return { error: null, message: 'Renamed.' };
  } catch (error) {
    return toFormError(error);
  }
}
