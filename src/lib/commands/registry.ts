import 'server-only';
import { TRASH_COMMANDS } from '@/lib/trash/commands';
import type { AnyCommand } from './define';
import { continueCommandRuns, type ContinueSummary } from './runner';

/**
 * Every command the console can run, by name (spec/v3.md §23.2).
 *
 * The runner itself takes a definition, not a name, so it can be tested with
 * a toy command. This is where a *stored* name — `command_runs.command`, read
 * back by a continuation — turns into code again, and where the one generic set
 * of Server Actions looks up what it was asked to run.
 *
 * **Adding a command is one line here.** Each module keeps its definitions next
 * to the code they call (`S`'s in the audience workspace, `T`'s beside the send
 * wizard) and appends its array below. A name must never be reused for a
 * different operation: a run paused under the old meaning would be continued
 * under the new one.
 */
const COMMANDS: readonly AnyCommand[] = [...TRASH_COMMANDS];

const byName = new Map(COMMANDS.map((command) => [command.name, command]));
if (byName.size !== COMMANDS.length) {
  throw new Error('Two commands share a name. Every command name must be unique.');
}

export function getCommand(name: string): AnyCommand | undefined {
  return byName.get(name);
}

/**
 * The scheduler tick's call (§27.1): continue every unfinished run until
 * `deadline` (epoch ms). `U` owns the tick route; this is all it needs from `Q`.
 */
export function continueRegisteredRuns(deadline: number): Promise<ContinueSummary> {
  return continueCommandRuns({ deadline, lookup: getCommand });
}
