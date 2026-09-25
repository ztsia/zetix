import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { requireRole } from '@/lib/auth/guards';
import { parseTableState } from '@/components/data-table/url-state';
import { listActivity, listRuns } from '@/lib/activity/queries';
import { getConcertHeader } from '../shows/queries';
import { ActivityView } from './activity-view';
import { maskForRole, masksContacts } from '@/lib/auth/mask';

export const metadata: Metadata = { title: 'Activity' };

/**
 * `/admin/concerts/{id}/activity` — what changed, who changed it, and every
 * command run (spec/v3.md §23.1, §23.3, §23.6).
 *
 * Two tabs over one URL state: **Changes** is the concert's `audit_log`, with
 * built-in views per kind of record and the admin's own saved views (§22.2);
 * **Command runs** lists every run, each opening its per-row report. A change a
 * command made links to its run, and `?run=` narrows Changes to one run.
 */
export default async function ActivityPage({
  params,
  searchParams,
}: {
  params: Promise<{ concertId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireRole('ADMIN', 'VIEWER');
  const { concertId: raw } = await params;
  const concertId = Number(raw);
  if (!Number.isInteger(concertId) || concertId <= 0) notFound();

  const concert = await getConcertHeader(concertId);
  if (!concert) notFound();

  const state = parseTableState(await searchParams, { extraKeys: ['tab', 'view', 'run'] });
  const tab = state.extra.tab === 'runs' ? 'runs' : 'changes';
  const runId = Number(state.extra.run);

  const [changes, runs] = await Promise.all([
    tab === 'changes'
      ? listActivity(concertId, {
          view: state.extra.view ?? null,
          search: state.search,
          runId: Number.isInteger(runId) && runId > 0 ? runId : null,
          pageIndex: state.pageIndex,
          pageSize: state.pageSize,
          withoutReason: masksContacts(user.role),
        })
      : null,
    tab === 'runs' ? listRuns(concertId, { pageIndex: state.pageIndex, pageSize: state.pageSize }) : null,
  ]);

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold">Activity</h1>
        <p className="text-muted-foreground text-sm">
          Every change made in this concert, newest first, and every bulk command with its report.
        </p>
      </div>
      <ActivityView
        concertId={concertId}
        timeZone={concert.timezone ?? 'UTC'}
        state={state}
        tab={tab}
        changes={maskForRole(user.role, changes)}
        runs={maskForRole(user.role, runs)}
      />
    </div>
  );
}
