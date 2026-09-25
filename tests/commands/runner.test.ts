import { beforeEach, describe, expect, it } from 'vitest';
import { sql as dsql } from 'drizzle-orm';
import { z } from 'zod';
import { resetDb, sql } from '../helpers/db';
import { createConcert, createPlayers, setSystemSetting } from '../helpers/fixtures';
import { pgError } from '@/db/errors';
import { defineCommand, SkipItem, type AnyCommand } from '@/lib/commands/define';
import {
  cancelRun,
  CommandInputError,
  continueCommandRuns,
  continueRun,
  previewCommand,
  readRun,
  startCommand,
} from '@/lib/commands/runner';

/**
 * The command runner — spec/v3.md §23.1, §23.3, §22.3, §27.1.
 *
 * Driven by a toy command defined here, *Deactivate players*, so these tests
 * are about the runner's promises and nothing else:
 *
 * - preview writes nothing, and says per row what will be skipped and why;
 * - a filter selection is resolved on the server at run time, minus exclusions;
 * - one row fails without taking the others with it;
 * - a re-run over the same selection does only what is left;
 * - a large irreversible run needs the typed phrase, naming the count;
 * - a run that outlives its budget is continued, and the lease keeps two
 *   workers off one run.
 */

type Filter = { nameContains: string };

let applied: number[] = [];

function deactivate(opts: { irreversible?: boolean } = {}) {
  return defineCommand<Filter, Record<string, never>>({
    name: 'test.players.deactivate',
    entityType: 'player',
    verb: 'Deactivate',
    noun: { one: 'player', many: 'players' },
    irreversible: opts.irreversible ?? false,
    filter: z.object({ nameContains: z.string() }).strict(),
    params: z.object({}).strict(),
    async match(tx, ctx, filter) {
      const rows = await tx.execute<{ id: string }>(dsql`
        select id from players
         where concert_id = ${ctx.concertId}
           and deleted_at is null
           and full_name ilike ${'%' + filter.nameContains + '%'}
         order by id
      `);
      return rows.map((row) => Number(row.id));
    },
    async describe(tx, ctx, ids, { lock }) {
      const rows = await tx.execute<{ id: string; full_name: string; is_active: boolean }>(dsql`
        select id, full_name, is_active from players
         where concert_id = ${ctx.concertId}
           and id = any(${`{${ids.join(',')}}`}::bigint[])
         order by id
         ${lock ? dsql`for update` : dsql``}
      `);
      return rows.map((row) => ({
        id: Number(row.id),
        label: row.full_name,
        skip: row.is_active ? null : 'Already inactive.',
      }));
    },
    async blastRadius(tx, ctx, ids) {
      return [{ count: ids.length, text: 'players lose their invite link', tone: 'warning' }];
    },
    async apply(tx, ctx, row) {
      if (row.label === 'Late skip') throw new SkipItem('Decided at run time.');
      await tx.execute(dsql`update players set is_active = false where id = ${row.id}`);
      // After the write, so a savepoint that failed to roll back would show.
      if (row.label === 'Explode') throw new Error('The row refused.');
      applied.push(row.id);
      await ctx.audit({ action: 'player.deactivated', entityType: 'player', entityId: row.id });
      return { deactivated: row.label };
    },
  });
}

let concertId: number;
let otherConcertId: number;
let players: number[];

const far = () => Date.now() + 60_000;

async function rename(id: number, name: string) {
  await sql`update players set full_name = ${name} where id = ${id}`;
}

async function active(ids: number[]): Promise<boolean[]> {
  const rows = await sql<{ id: string; is_active: boolean }[]>`
    select id, is_active from players where id = any(${ids}) order by id
  `;
  return rows.map((row) => row.is_active);
}

beforeEach(async () => {
  await resetDb();
  applied = [];
  concertId = await createConcert('Runner');
  otherConcertId = await createConcert('Other');
  players = await createPlayers(concertId, 4);
  await setSystemSetting('admin.typed_confirm_above', 2);
});

describe('preview', () => {
  it('writes nothing and reports each row, the skips and the blast radius', async () => {
    await sql`update players set is_active = false where id = ${players[1]}`;

    const preview = await previewCommand(
      deactivate(),
      { concertId, selection: { ids: players } },
      null,
    );

    expect(preview.total).toBe(4);
    expect(preview.runnable).toBe(3);
    expect(preview.skipped).toEqual([{ reason: 'Already inactive.', count: 1 }]);
    expect(preview.blastRadius).toEqual([
      { count: 3, text: 'players lose their invite link', tone: 'warning' },
    ]);
    expect(await active(players)).toEqual([true, false, true, true]);
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from command_runs`;
    expect(n).toBe(0);
  });

  it('refuses to write, even if a definition tries', async () => {
    const writer = { ...deactivate(), describe: async (tx: never) => {
      await (tx as { execute: (q: unknown) => Promise<unknown> }).execute(
        dsql`update players set is_active = false`,
      );
      return [];
    } } as unknown as AnyCommand;

    await expect(
      previewCommand(writer, { concertId, selection: { ids: players } }, null),
    ).rejects.toSatisfy((error) => pgError(error)?.code === '25006'); // read_only_sql_transaction
    expect(await active(players)).toEqual([true, true, true, true]);
  });

  it('reports ids from another concert as not found rather than acting on them', async () => {
    const [stranger] = await createPlayers(otherConcertId, 1);
    const preview = await previewCommand(
      deactivate(),
      { concertId, selection: { ids: [players[0], stranger] } },
      null,
    );
    expect(preview.runnable).toBe(1);
    expect(preview.skipped).toEqual([{ reason: 'No longer exists in this concert.', count: 1 }]);
  });

  it('resolves "select all matching" on the server, minus the exclusions', async () => {
    await rename(players[0], 'Alice Tan');
    await rename(players[1], 'Alan Lim');
    await rename(players[2], 'Bob Ong');

    const preview = await previewCommand(
      deactivate(),
      {
        concertId,
        selection: { filter: { nameContains: 'al' }, excludedIds: [players[1]] },
      },
      null,
    );
    expect(preview.byFilter).toBe(true);
    expect(preview.rows.map((row) => row.id)).toEqual([players[0]]);
  });

  it('rejects a malformed selection before touching the database', async () => {
    await expect(
      previewCommand(deactivate(), { concertId, selection: { ids: ['1; drop table'] } }, null),
    ).rejects.toBeInstanceOf(CommandInputError);
    await expect(
      previewCommand(
        deactivate(),
        { concertId, selection: { filter: { nameContains: 'a', extra: 1 }, excludedIds: [] } },
        null,
      ),
    ).rejects.toBeInstanceOf(CommandInputError);
  });
});

describe('run and report', () => {
  it('works every row, records the run, and audits each change with the reason', async () => {
    const report = await startCommand(
      deactivate(),
      { concertId, selection: { ids: players.slice(0, 2) }, reason: 'Left the orchestra' },
      { actorId: null, deadline: far() },
    );

    expect(report.status).toBe('COMPLETED');
    expect(report).toMatchObject({ total: 2, done: 2, skipped: 0, failed: 0 });
    expect(report.items.map((item) => item.status)).toEqual(['DONE', 'DONE']);
    expect(await active(players)).toEqual([false, false, true, true]);

    const audits = await sql<{ reason: string; concert_id: string; command_run_id: string }[]>`
      select reason, concert_id, command_run_id from audit_log
       where action = 'player.deactivated' order by id
    `;
    expect(audits).toHaveLength(2);
    for (const row of audits) {
      expect(row.reason).toBe('Left the orchestra');
      expect(Number(row.concert_id)).toBe(concertId);
      expect(Number(row.command_run_id)).toBe(report.id);
    }

    const [run] = await sql<{ selection: unknown; lease_until: Date | null }[]>`
      select selection, lease_until from command_runs where id = ${report.id}
    `;
    expect(run.selection).toEqual({ ids: players.slice(0, 2) });
    expect(run.lease_until).toBeNull();
  });

  it('fails one row without undoing the others, and rolls back what that row wrote', async () => {
    await rename(players[1], 'Explode');
    const report = await startCommand(
      deactivate(),
      { concertId, selection: { ids: players.slice(0, 3) } },
      { actorId: null, deadline: far() },
    );

    expect(report).toMatchObject({ status: 'COMPLETED', done: 2, failed: 1 });
    expect(report.items[1]).toMatchObject({ status: 'FAILED', error: 'The row refused.' });
    expect(await active(players)).toEqual([false, true, false, true]);
  });

  it('records a skip decided at run time', async () => {
    await rename(players[0], 'Late skip');
    const report = await startCommand(
      deactivate(),
      { concertId, selection: { ids: [players[0]] } },
      { actorId: null, deadline: far() },
    );
    expect(report.items[0]).toMatchObject({
      status: 'SKIPPED',
      outcome: { reason: 'Decided at run time.' },
    });
  });

  it('does only what is left when run again over the same selection', async () => {
    const input = { concertId, selection: { ids: players.slice(0, 2) } };
    await startCommand(deactivate(), input, { actorId: null, deadline: far() });
    applied = [];

    const again = await startCommand(deactivate(), input, { actorId: null, deadline: far() });
    expect(again).toMatchObject({ done: 0, skipped: 2 });
    expect(again.items.every((item) => item.outcome && (item.outcome as { reason: string }).reason === 'Already inactive.')).toBe(true);
    expect(applied).toEqual([]);
  });

  it('resolves a filter at run time, so a row that started matching is included', async () => {
    await rename(players[0], 'Alice Tan');
    const input = {
      concertId,
      selection: { filter: { nameContains: 'al' }, excludedIds: [] as number[] },
    };
    const preview = await previewCommand(deactivate(), input, null);
    expect(preview.total).toBe(1);

    await rename(players[3], 'Alan Lim');
    const report = await startCommand(deactivate(), input, { actorId: null, deadline: far() });
    expect(report.items.map((item) => item.entityId)).toEqual([players[0], players[3]]);
  });

  it('refuses an empty selection instead of recording an empty run', async () => {
    await expect(
      startCommand(deactivate(), { concertId, selection: { ids: [] } }, { actorId: null, deadline: far() }),
    ).rejects.toThrow(/Nothing is selected/);
  });

  it('never reads another concert’s run', async () => {
    const report = await startCommand(
      deactivate(),
      { concertId, selection: { ids: [players[0]] } },
      { actorId: null, deadline: far() },
    );
    await expect(readRun(report.id, otherConcertId)).rejects.toBeInstanceOf(CommandInputError);
  });
});

describe('typed confirmation (§23.3)', () => {
  it('is not asked of a reversible command, however large', async () => {
    const preview = await previewCommand(deactivate(), { concertId, selection: { ids: players } }, null);
    expect(preview.confirmation.required).toBe(false);
  });

  it('is not asked of an irreversible command at or below the threshold', async () => {
    const preview = await previewCommand(
      deactivate({ irreversible: true }),
      { concertId, selection: { ids: players.slice(0, 2) } },
      null,
    );
    expect(preview.confirmation).toMatchObject({ required: false, threshold: 2 });
  });

  it('is required above the threshold, and the phrase names the count', async () => {
    const def = deactivate({ irreversible: true });
    const input = { concertId, selection: { ids: players.slice(0, 3) } };

    const preview = await previewCommand(def, input, null);
    expect(preview.confirmation).toEqual({
      required: true,
      phrase: 'deactivate 3 players',
      threshold: 2,
    });

    await expect(startCommand(def, input, { actorId: null, deadline: far() })).rejects.toThrow(
      'Type "deactivate 3 players" to confirm.',
    );
    await expect(
      startCommand(def, { ...input, confirmPhrase: 'deactivate 4 players' }, { actorId: null, deadline: far() }),
    ).rejects.toThrow(/Preview it again/);
    expect(await active(players)).toEqual([true, true, true, true]);

    const report = await startCommand(
      def,
      { ...input, confirmPhrase: '  Deactivate   3 players ' },
      { actorId: null, deadline: far() },
    );
    expect(report.done).toBe(3);
  });

  it('counts only rows that will run, and refuses a phrase from a selection that grew', async () => {
    const def = deactivate({ irreversible: true });
    await rename(players[0], 'Alice');
    await rename(players[1], 'Alan');
    await rename(players[2], 'Alma');
    const input = { concertId, selection: { filter: { nameContains: 'al' }, excludedIds: [] as number[] } };

    const preview = await previewCommand(def, input, null);
    expect(preview.confirmation.phrase).toBe('deactivate 3 players');

    await rename(players[3], 'Albert');
    await expect(
      startCommand(def, { ...input, confirmPhrase: 'deactivate 3 players' }, { actorId: null, deadline: far() }),
    ).rejects.toThrow(/now comes to 4 players/);
  });

  it('requires the phrase when nobody has set the threshold', async () => {
    await sql`delete from system_settings where key = 'admin.typed_confirm_above'`;
    const preview = await previewCommand(
      deactivate({ irreversible: true }),
      { concertId, selection: { ids: [players[0]] } },
      null,
    );
    expect(preview.confirmation).toEqual({
      required: true,
      phrase: 'deactivate 1 player',
      threshold: null,
    });
  });
});

describe('continuation and the lease (§23.1, §27.1)', () => {
  const lookup = (name: string) => (name === 'test.players.deactivate' ? deactivate() : undefined);

  it('pauses at the deadline, releasing the lease, and the tick finishes the run', async () => {
    const paused = await startCommand(
      deactivate(),
      { concertId, selection: { ids: players } },
      { actorId: null, deadline: Date.now() - 1 },
    );
    expect(paused).toMatchObject({ status: 'RUNNING', done: 0 });
    const [run] = await sql<{ lease_until: Date | null }[]>`
      select lease_until from command_runs where id = ${paused.id}
    `;
    expect(run.lease_until).toBeNull();

    const summary = await continueCommandRuns({ deadline: far(), lookup });
    expect(summary).toEqual({ worked: 1, completed: 1, failed: 0 });
    expect((await readRun(paused.id, concertId)).status).toBe('COMPLETED');
    expect(await active(players)).toEqual([false, false, false, false]);
  });

  it('leaves a run alone while another worker holds an unexpired lease', async () => {
    const paused = await startCommand(
      deactivate(),
      { concertId, selection: { ids: players } },
      { actorId: null, deadline: Date.now() - 1 },
    );
    await sql`update command_runs set lease_until = now() + interval '1 hour' where id = ${paused.id}`;

    expect(await continueCommandRuns({ deadline: far(), lookup })).toEqual({
      worked: 0,
      completed: 0,
      failed: 0,
    });
    expect((await continueRun(deactivate(), paused.id, concertId, far())).done).toBe(0);

    // An expired lease is a crashed worker's, and is taken over.
    await sql`update command_runs set lease_until = now() - interval '1 second' where id = ${paused.id}`;
    expect((await continueRun(deactivate(), paused.id, concertId, far())).status).toBe('COMPLETED');
  });

  it('stops a worker whose lease was taken over, after the row it was on', async () => {
    const paused = await startCommand(
      deactivate(),
      { concertId, selection: { ids: players } },
      { actorId: null, deadline: Date.now() - 1 },
    );

    // Simulates another worker taking the run between rows. Written on the
    // row's own transaction, which already holds the run row.
    const plain = deactivate();
    const takeover: AnyCommand = {
      ...plain,
      apply: async (tx, ctx, row) => {
        const outcome = await plain.apply(tx, ctx, row);
        await tx.execute(dsql`
          update command_runs set lease_until = now() + interval '1 hour' where id = ${ctx.runId}
        `);
        return outcome;
      },
    };

    const after = await continueRun(takeover, paused.id, concertId, far());
    expect(after).toMatchObject({ status: 'RUNNING', done: 1 });
    expect(after.items.filter((item) => item.status === 'PENDING')).toHaveLength(3);
  });

  it('closes a run whose command no longer exists instead of retrying it forever', async () => {
    const paused = await startCommand(
      deactivate(),
      { concertId, selection: { ids: players } },
      { actorId: null, deadline: Date.now() - 1 },
    );
    const summary = await continueCommandRuns({ deadline: far(), lookup: () => undefined });
    expect(summary.failed).toBe(1);
    expect((await readRun(paused.id, concertId)).status).toBe('FAILED');
  });

  it('cancels: untouched rows are recorded as skipped, and no worker picks the run up', async () => {
    const paused = await startCommand(
      deactivate(),
      { concertId, selection: { ids: players } },
      { actorId: null, deadline: Date.now() - 1 },
    );
    const cancelled = await cancelRun(paused.id, concertId);
    expect(cancelled).toMatchObject({ status: 'CANCELLED', skipped: 4, done: 0 });

    expect((await continueCommandRuns({ deadline: far(), lookup })).worked).toBe(0);
    expect(await active(players)).toEqual([true, true, true, true]);
  });
});
