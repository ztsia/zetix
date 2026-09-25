import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, sql } from '../helpers/db';
import { createConcert, createShow } from '../helpers/fixtures';
import { listActivity, listRuns } from '@/lib/activity/queries';

/**
 * The Activity log reader (spec/v3.md §23.1, §23.6): one concert's changes,
 * narrowed by view, search or run, and its command runs.
 */
let concertId: number;
let otherId: number;
let showId: number;

beforeEach(async () => {
  await resetDb();
  concertId = await createConcert('Mine');
  otherId = await createConcert('Theirs');
  showId = await createShow(concertId, 100);
});

const page = { search: '', view: null, runId: null, pageIndex: 0, pageSize: 25 };

describe('listActivity', () => {
  it('reads one concert, newest first, and never another', async () => {
    await sql`insert into audit_log (action, entity_type, entity_id) values
      ('show.created', 'show', ${String(showId)}),
      ('concert.updated', 'concert', ${String(concertId)}),
      ('concert.updated', 'concert', ${String(otherId)})`;
    const result = await listActivity(concertId, page);
    expect(result.total).toBe(2);
    expect(result.rows.map((row) => row.action)).toEqual(['concert.updated', 'show.created']);
  });

  it('narrows by built-in view, by search, and by run', async () => {
    const [run] = await sql<{ id: string }[]>`
      insert into command_runs (concert_id, command, selection, status, total)
      values (${concertId}, 'trash.restore.party', '{"ids":[1]}', 'COMPLETED', 1) returning id
    `;
    await sql`insert into audit_log (action, entity_type, entity_id, concert_id, command_run_id, reason) values
      ('registration.restored', 'registration', '1', ${concertId}, ${run.id}, 'Came back'),
      ('show.updated', 'show', ${String(showId)}, ${concertId}, null, null)`;

    expect((await listActivity(concertId, { ...page, view: 'parties' })).total).toBe(1);
    expect((await listActivity(concertId, { ...page, view: 'setup' })).total).toBe(1);
    expect((await listActivity(concertId, { ...page, search: 'came back' })).rows[0].action).toBe(
      'registration.restored',
    );
    expect((await listActivity(concertId, { ...page, runId: Number(run.id) })).total).toBe(1);
  });
});

describe('listRuns', () => {
  it('lists this concert’s runs only', async () => {
    await sql`insert into command_runs (concert_id, command, selection, status, total) values
      (${concertId}, 'a', '{}', 'COMPLETED', 1), (${otherId}, 'b', '{}', 'COMPLETED', 1)`;
    const result = await listRuns(concertId, { pageIndex: 0, pageSize: 25 });
    expect(result.rows.map((row) => row.command)).toEqual(['a']);
  });
});
