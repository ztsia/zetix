import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, sql } from '../helpers/db';
import { setSystemSetting } from '../helpers/fixtures';

/**
 * The tick's order and its budget (spec/v3.md §27.1), with each step replaced
 * by a recorder: complete shows, send what is due, continue command runs,
 * sync the inbox — and one step failing never stops the ones after it.
 */

const calls: string[] = [];
const autoCompleteShows = vi.fn();
const dispatchBatch = vi.fn();
const continueRegisteredRuns = vi.fn();
const runInboxSync = vi.fn();

vi.mock('@/lib/shows/complete', () => ({ autoCompleteShows: () => autoCompleteShows() }));
vi.mock('@/lib/email/dispatch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/email/dispatch')>()),
  dispatchBatch: (o: unknown) => dispatchBatch(o),
}));
vi.mock('@/lib/commands/registry', () => ({ continueRegisteredRuns: (d: number) => continueRegisteredRuns(d) }));
vi.mock('@/lib/inbox/run', () => ({ runInboxSync: (o: unknown) => runInboxSync(o) }));

const { runTick } = await import('@/lib/scheduler/tick');

const dispatched = { sent: 1, failed: 0, deferred: 0, remaining: 0, dailyCapReached: false, warnings: [], reclaimed: 0, backlog: {} };

beforeEach(async () => {
  await resetDb();
  calls.length = 0;
  autoCompleteShows.mockReset().mockImplementation(async () => (calls.push('complete'), []));
  dispatchBatch.mockReset().mockImplementation(async () => (calls.push('send'), dispatched));
  continueRegisteredRuns.mockReset().mockImplementation(async () => (calls.push('runs'), { worked: 0, completed: 0, failed: 0 }));
  runInboxSync.mockReset().mockImplementation(async () => (calls.push('inbox'), { status: 'synced', folders: [] }));
  await setSystemSetting('inbox.sync_budget_seconds', 20);
  await setSystemSetting('scheduler.history_days', 7);
});

describe('one tick', () => {
  it('runs the four steps in the spec’s order and records a heartbeat', async () => {
    const report = await runTick({ source: 'pg_cron' });
    expect(calls).toEqual(['complete', 'send', 'runs', 'inbox']);

    const [beat] = await sql<{ source: string; finished_at: string | null; error: string | null; report: { dispatch: { ok: boolean } } }[]>`
      select source, finished_at, error, report from scheduler_heartbeat where id = ${report.heartbeatId}`;
    expect(beat.source).toBe('pg_cron');
    expect(beat.finished_at).not.toBeNull();
    expect(beat.error).toBeNull();
    expect(beat.report.dispatch.ok).toBe(true);
  });

  it('reserves the inbox its share: sending and runs must finish before it begins', async () => {
    const started = Date.now();
    await runTick({ source: 'manual', budgetMs: 48_000 });
    const runsDeadline = continueRegisteredRuns.mock.calls[0][0] as number;
    const { deadline: inboxDeadline } = runInboxSync.mock.calls[0][0] as { deadline: number };
    const { sendWindowMs } = dispatchBatch.mock.calls[0][0] as { sendWindowMs: number };

    // 48s total, 20s for the inbox: runs stop by 28s, sending starts nothing after 14s.
    expect(runsDeadline - started).toBeGreaterThan(27_000);
    expect(runsDeadline - started).toBeLessThanOrEqual(28_000);
    expect(inboxDeadline - started).toBeLessThanOrEqual(48_000);
    expect(inboxDeadline).toBeGreaterThan(runsDeadline);
    expect(sendWindowMs).toBeLessThanOrEqual(14_000);
    expect(sendWindowMs).toBeGreaterThan(13_000);
  });

  it('keeps going past a failing step, and says which one failed', async () => {
    autoCompleteShows.mockRejectedValue(new Error('shows exploded'));
    dispatchBatch.mockRejectedValue(new Error('GMAIL_APP_PASSWORD is not set'));
    runInboxSync.mockResolvedValue({ status: 'failed', error: 'IMAP refused' });
    const report = await runTick({ source: 'manual' });

    expect(continueRegisteredRuns).toHaveBeenCalled();
    expect(runInboxSync).toHaveBeenCalled();
    expect(report.completions).toMatchObject({ ok: false, error: 'shows exploded' });

    const [beat] = await sql<{ error: string }[]>`select error from scheduler_heartbeat where id = ${report.heartbeatId}`;
    expect(beat.error).toContain('complete shows: shows exploded');
    expect(beat.error).toContain('send: GMAIL_APP_PASSWORD is not set');
    expect(beat.error).toContain('inbox: IMAP refused');
  });

  it('records a mailbox folder that could not be read as a failed step', async () => {
    runInboxSync.mockResolvedValue({
      status: 'synced',
      folders: [{ role: 'inbox', path: 'INBOX', read: 0, stored: 0, bounces: 0, replies: 0, skipped: 0, reset: false, complete: false, error: 'IMAP down' }],
    });
    const report = await runTick({ source: 'manual' });
    const [beat] = await sql<{ error: string }[]>`select error from scheduler_heartbeat where id = ${report.heartbeatId}`;
    expect(beat.error).toBe('inbox INBOX: IMAP down');
  });

  it('can store a step error that quotes a NUL byte', async () => {
    dispatchBatch.mockRejectedValue(new Error('bad \u0000 byte'));
    const report = await runTick({ source: 'manual' });
    const [beat] = await sql<{ error: string; finished_at: string | null }[]>`
      select error, finished_at from scheduler_heartbeat where id = ${report.heartbeatId}`;
    expect(beat.finished_at).not.toBeNull();
    expect(beat.error).toBe('send: bad  byte');
  });

  it('trims heartbeats older than scheduler.history_days, and only those', async () => {
    await sql`insert into scheduler_heartbeat (source, started_at) values
      ('pg_cron', now() - interval '8 days'), ('pg_cron', now() - interval '6 days')`;
    const report = await runTick({ source: 'pg_cron' });
    expect(report.trimmed).toBe(1);
    const [row] = await sql<{ n: number }[]>`select count(*)::int as n from scheduler_heartbeat`;
    expect(row.n).toBe(2);
  });

  it('trims nothing when scheduler.history_days is unset: no retention is invented here', async () => {
    await sql`delete from system_settings where key = 'scheduler.history_days'`;
    await sql`insert into scheduler_heartbeat (source, started_at) values ('pg_cron', now() - interval '400 days')`;
    const report = await runTick({ source: 'pg_cron' });
    expect(report.trimmed).toBe(0);
  });
});
