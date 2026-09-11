'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { requireAdmin } from '@/lib/auth/guards';
import { writeAuditLog } from '@/lib/audit';
import { layoutSchema } from '@/lib/tickets/layout';
import {
  deleteTemplate,
  duplicateTemplate,
  loadTemplate,
  saveTemplate,
  setDefaultTemplate,
} from '@/lib/tickets/templates';

/**
 * The editor's three mutations (spec/tickets.md §10.3, §10.5).
 *
 * Server Actions, because each is an admin button rather than a URL anything
 * external calls (CLAUDE.md conventions). **Every one re-checks
 * `requireAdmin()`**: a Server Action is its own entry point, so the page's
 * guard does not cover it (modules.md §5.2.1).
 *
 * The layout arrives from a browser and is parsed with the same `zod` schema the
 * renderer parses it with. It is the contract between the editor and module
 * `D`'s renderer, and it is `.strict()` — a key the editor invents is rejected
 * here rather than stored and silently ignored at render time.
 */

export type TemplateActionResult =
  | { ok: true; message: string; templateId?: number; version?: number }
  | { ok: false; error: string };

const saveSchema = z.object({
  concertId: z.number().int().positive(),
  templateId: z.number().int().positive(),
  name: z.string().trim().min(1, 'A template needs a name.').max(120),
  layout: layoutSchema,
  /** Null clears the background; omitted leaves it alone. */
  backgroundAssetPath: z.string().min(1).nullable().optional(),
});

export async function saveTemplateAction(
  input: z.infer<typeof saveSchema>,
): Promise<TemplateActionResult> {
  await requireAdmin();

  const parsed = saveSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: firstIssue(parsed.error) };
  }

  const { concertId, templateId } = parsed.data;
  const before = await loadTemplate(concertId, templateId);
  if (!before) return { ok: false, error: 'That template no longer exists.' };

  try {
    const result = await saveTemplate(parsed.data);

    /**
     * **Replacing a background never deletes the file it replaced.**
     *
     * This used to delete the old asset whenever an in-place save changed the
     * path, on the reasoning that an in-place save leaves nothing pointing at
     * it. That reasoning was wrong, and a QA pass proved it: a path is not
     * owned by one row. `saveTemplate()`'s clone copies
     * `background_asset_path` verbatim onto the new version, and
     * `duplicateTemplate()` copies it into a whole new lineage — so the version
     * being edited can name the same file as a **pinned, already-issued** one.
     * Replacing the background on the newer row then unlinked the artwork the
     * issued ticket renders from, and because `backgroundFor()` degrades
     * instead of throwing, that ticket silently lost its design (§10.5).
     *
     * An orphaned file costs a few hundred kilobytes in a bucket holding a
     * handful of images. Deleting the wrong one costs a ticket that no longer
     * matches the PDF already in someone's inbox, discovered at the door. If
     * reclaiming them is ever worth it, it needs a reference check across every
     * version's `background_asset_path` **and** every layout's `IMAGE`
     * elements — not a comparison against one row's previous value.
     */
    await writeAuditLog({
      action: result.cloned ? 'ticket_template.versioned' : 'ticket_template.updated',
      entityType: 'ticket_template',
      entityId: result.templateId,
      before: {
        id: before.id,
        version: before.version,
        name: before.name,
        elements: before.elementCount,
        issued: before.issuedCount,
      },
      after: {
        id: result.templateId,
        version: result.version,
        name: parsed.data.name,
        elements: parsed.data.layout.elements.length,
      },
    });

    revalidatePath(`/admin/concerts/${concertId}/tickets/templates`);
    revalidatePath(`/admin/concerts/${concertId}/tickets/templates/${result.templateId}`);

    return {
      ok: true,
      templateId: result.templateId,
      version: result.version,
      message: result.cloned
        ? `Saved as version ${result.version}. Version ${before.version} has ${before.issuedCount} ticket${
            before.issuedCount === 1 ? '' : 's'
          } issued against it and keeps its design.`
        : `Saved. Still version ${result.version} — no tickets have been issued from it yet.`,
    };
  } catch (error) {
    return { ok: false, error: message(error) };
  }
}

const templateSchema = z.object({
  concertId: z.number().int().positive(),
  templateId: z.number().int().positive(),
});

export async function setDefaultTemplateAction(
  input: z.infer<typeof templateSchema>,
): Promise<TemplateActionResult> {
  await requireAdmin();

  const parsed = templateSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Malformed request.' };

  try {
    await setDefaultTemplate(parsed.data.concertId, parsed.data.templateId);
    await writeAuditLog({
      action: 'ticket_template.default_set',
      entityType: 'ticket_template',
      entityId: parsed.data.templateId,
      after: { concertId: parsed.data.concertId },
    });
    revalidatePath(`/admin/concerts/${parsed.data.concertId}/tickets/templates`);
    return {
      ok: true,
      message:
        'Default set. Tickets issued from now on use it — those already issued keep the ' +
        'template they were pinned to.',
    };
  } catch (error) {
    return { ok: false, error: message(error) };
  }
}

export async function duplicateTemplateAction(
  input: z.infer<typeof templateSchema>,
): Promise<TemplateActionResult> {
  await requireAdmin();

  const parsed = templateSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Malformed request.' };

  try {
    const { templateId } = await duplicateTemplate(parsed.data.concertId, parsed.data.templateId);
    await writeAuditLog({
      action: 'ticket_template.duplicated',
      entityType: 'ticket_template',
      entityId: templateId,
      before: { id: parsed.data.templateId },
    });
    revalidatePath(`/admin/concerts/${parsed.data.concertId}/tickets/templates`);
    return { ok: true, templateId, message: 'Duplicated.' };
  } catch (error) {
    return { ok: false, error: message(error) };
  }
}

/**
 * Delete a template (spec/tickets.md §10.5).
 *
 * Both refusals — a version tickets are pinned to, and the default — come back
 * as `error` with the sentence naming the numbers, which the dialog renders
 * verbatim rather than replacing with a generic failure. The count of pinned
 * tickets *is* the decision the admin has to make.
 */
export async function deleteTemplateAction(
  input: z.infer<typeof templateSchema>,
): Promise<TemplateActionResult> {
  await requireAdmin();

  const parsed = templateSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Malformed request.' };

  try {
    await deleteTemplate(parsed.data.concertId, parsed.data.templateId);
    await writeAuditLog({
      action: 'ticket_template.deleted',
      entityType: 'ticket_template',
      entityId: parsed.data.templateId,
      before: { concertId: parsed.data.concertId },
    });
    revalidatePath(`/admin/concerts/${parsed.data.concertId}/tickets/templates`);
    return { ok: true, message: 'Template deleted.' };
  } catch (error) {
    return { ok: false, error: message(error) };
  }
}

function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return 'Malformed request.';
  const path = issue.path.join('.');
  return path ? `${path}: ${issue.message}` : issue.message;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong.';
}
