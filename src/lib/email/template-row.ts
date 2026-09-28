import 'server-only';
import { sql } from 'drizzle-orm';
import type { Executor } from '@/db/allocation';
import { DEFAULT_TEMPLATES } from './default-templates';
import type { TemplateKey } from './templates';

/**
 * The template row, seeding the default wording if the install has never had
 * it — a message the system sends by itself (a receipt, a verification link, a
 * player invite) must not wait for someone to open the templates page. A
 * template an admin deleted is not re-created: the caller skips the message
 * and says so.
 */
export async function templateFor(tx: Executor, key: string): Promise<{ subject: string; body_md: string } | null> {
  const read = () =>
    tx.execute<{ subject: string; body_md: string; deleted: boolean }>(sql`
      select subject, body_md, deleted_at is not null as deleted from email_templates where key = ${key}
    `);
  let [row] = await read();
  if (!row && key in DEFAULT_TEMPLATES) {
    const seed = DEFAULT_TEMPLATES[key as TemplateKey];
    await tx.execute(sql`
      insert into email_templates (key, name, subject, body_md)
      values (${key}, ${seed.name}, ${seed.subject}, ${seed.bodyMd})
      on conflict (key) do nothing
    `);
    [row] = await read();
  }
  return row && !row.deleted ? row : null;
}

