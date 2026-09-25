/**
 * QA (module Q) concurrency worker. One process = one getDb() connection, so
 * several of these in parallel really contend for row locks.
 *   restore-party <concertId> <regId>
 *   continue       (continueRegisteredRuns, 20s deadline)
 *   continue-run <concertId> <runId>
 */
import { startCommand, continueRun } from '@/lib/commands/runner';
import { getCommand, continueRegisteredRuns } from '@/lib/commands/registry';

const [mode, a, b] = process.argv.slice(2);
const deadline = Date.now() + 20_000;
async function main() {
  if (mode === 'restore-party') {
    const r = await startCommand(getCommand('trash.restore.party')!, { concertId: Number(a), selection: { ids: [Number(b)] } }, { actorId: null, deadline });
    console.log(JSON.stringify({ mode, done: r.done, skipped: r.skipped, failed: r.failed, outcome: r.items[0]?.outcome, error: r.items[0]?.error }));
  } else if (mode === 'continue') {
    console.log(JSON.stringify({ mode, ...(await continueRegisteredRuns(deadline)) }));
  } else if (mode === 'continue-run') {
    const r = await continueRun(getCommand('trash.restore.player')!, Number(b), Number(a), deadline);
    console.log(JSON.stringify({ mode, status: r.status, done: r.done }));
  }
  process.exit(0);
}
main().catch((e) => { console.log(JSON.stringify({ mode, error: String(e?.message ?? e) })); process.exit(1); });
