import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '@/db/client';
import { resetDb, sql as raw } from '../../tests/helpers/db';

/**
 * QA probe. Is the `::text::jsonb` double cast in
 * `src/app/(admin)/admin/settings/actions.ts` load-bearing under this driver?
 *
 * The branch has three tests written about it. Replacing it with a bare
 * `::jsonb` left all thirteen green, so this asks the database directly.
 */
describe('jsonb parameter casting', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('reports what each cast actually stores', async () => {
    const db = getDb();

    await db.execute(sql`
      insert into system_settings (key, value)
      values ('keepalive.enabled', ${JSON.stringify(false)}::text::jsonb)
    `);
    await db.execute(sql`
      insert into system_settings (key, value)
      values ('email.max_per_day', ${JSON.stringify(450)}::jsonb)
    `);

    const rows = await raw<{ key: string; kind: string; value: string }[]>`
      select key, jsonb_typeof(value) as kind, value::text as value
        from system_settings order by key
    `;
    // Printed rather than asserted: the point is the observation.
    console.log('CAST OBSERVATION', JSON.stringify(rows));
    expect(rows).toHaveLength(2);
  });
});
