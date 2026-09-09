import 'server-only';

import { sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { DEFAULT_TEMPLATES } from './default-templates';

export { DEFAULT_TEMPLATES } from './default-templates';

/**
 * Writes any template that does not yet exist, and leaves every existing row
 * alone.
 *
 * `on conflict do nothing`, deliberately not `do update`: an admin's edited
 * wording must survive a redeploy, a re-seed, and the next person who runs this
 * without reading it.
 */
export async function seedDefaultTemplates(): Promise<{ inserted: number }> {
  const rows = Object.entries(DEFAULT_TEMPLATES);
  const values = sql.join(
    rows.map(([key, t]) => sql`(${key}, ${t.name}, ${t.subject}, ${t.bodyMd})`),
    sql`, `,
  );
  const inserted = await getDb().execute<{ key: string }>(sql`
    insert into email_templates (key, name, subject, body_md)
    values ${values}
    on conflict (key) do nothing
    returning key
  `);
  return { inserted: inserted.length };
}
