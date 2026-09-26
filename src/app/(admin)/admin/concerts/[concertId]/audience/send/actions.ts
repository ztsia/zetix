'use server';

import { z } from 'zod';
import { getDb } from '@/db/client';
import { dbErrorMessage } from '@/db/errors';
import { requireRole } from '@/lib/auth/guards';
import { audienceFilterSchema, type AudienceFilter } from '@/lib/audience/filter';
import { idSchema, selectionSchema, type Selection } from '@/lib/commands/selection';
import { seedDefaultTemplates } from '@/lib/email/defaults';
import {
  checkUncheckedAddresses,
  renderEmailPreview,
  selectedParties,
  wizardSetup,
  type AddressCheckSummary,
  type EmailPreview,
  type WizardSetup,
} from '@/lib/delivery/wizard';

/**
 * The send wizard's own reads (spec/v3.md §24.1). The command runs through
 * the console's one set of command actions (`commands/actions.ts`); these lay
 * out its choices. Admin only: the wizard exists to send, and a viewer never
 * runs a command (§28).
 */

export type ActionResult<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * How long the Who step spends checking never-checked addresses before it
 * shows the preview. Infrastructure, not an operational value: it keeps the
 * step responsive and the action well inside the function limit; anything left
 * is reported and checked the next time the wizard opens.
 */
const ADDRESS_CHECK_BUDGET_MS = 8_000;
const ADDRESS_CHECK_CONCURRENCY = 8;

const selectionInput = selectionSchema(audienceFilterSchema);

export async function sendWizardSetupAction(
  concertId: number,
  selection: Selection<AudienceFilter>,
): Promise<ActionResult<WizardSetup & { parties: number; addresses: AddressCheckSummary }>> {
  const user = await requireRole('ADMIN');
  const parsed = z.object({ concertId: idSchema, selection: selectionInput }).safeParse({ concertId, selection });
  if (!parsed.success) return { ok: false, error: 'That selection was malformed.' };
  try {
    const ids = await selectedParties(getDb(), parsed.data.concertId, parsed.data.selection as Selection<AudienceFilter>);
    const addresses = await checkUncheckedAddresses(parsed.data.concertId, ids, {
      budgetMs: ADDRESS_CHECK_BUDGET_MS,
      concurrency: ADDRESS_CHECK_CONCURRENCY,
      actorId: user.id,
    });
    // The wording the Email step offers must exist before it is offered. Seeding
    // never overwrites an edited template, as on the templates page.
    await seedDefaultTemplates();
    const setup = await wizardSetup(parsed.data.concertId, ids);
    return { ok: true, value: { ...setup, parties: ids.length, addresses } };
  } catch (error) {
    return { ok: false, error: dbErrorMessage(error) };
  }
}

const previewInput = z.object({
  concertId: idSchema,
  registrationId: idSchema,
  templateKey: z.string().min(1).max(100),
  wording: z
    .object({ subject: z.string().max(500), bodyMd: z.string().max(50_000) })
    .nullable(),
});

export async function emailPreviewAction(
  concertId: number,
  registrationId: number,
  templateKey: string,
  wording: { subject: string; bodyMd: string } | null,
): Promise<ActionResult<EmailPreview>> {
  await requireRole('ADMIN');
  const parsed = previewInput.safeParse({ concertId, registrationId, templateKey, wording });
  if (!parsed.success) return { ok: false, error: 'That preview request was malformed.' };
  try {
    const preview = await renderEmailPreview(
      parsed.data.concertId,
      parsed.data.registrationId,
      parsed.data.templateKey,
      parsed.data.wording,
    );
    return preview ? { ok: true, value: preview } : { ok: false, error: 'That party or template no longer exists.' };
  } catch (error) {
    return { ok: false, error: dbErrorMessage(error) };
  }
}
