import { describe, expect, it } from 'vitest';
import {
  buildChecklist,
  heartbeatState,
  nameList,
  type ChecklistFacts,
  type SegmentFacts,
  type ShowFacts,
} from '@/lib/home/checklist';

/**
 * Home's setup checklist (spec/v3.md §29.3) and heartbeat (§27.2), without a
 * database: the page gathers facts, these decide what the facts mean.
 */

const segment = (over: Partial<SegmentFacts> = {}): SegmentFacts => ({
  id: 1,
  name: 'Public',
  audienceMode: 'PUBLIC',
  hasCapacity: true,
  hasBaseQuota: false,
  hasDesign: true,
  formOpened: true,
  parties: 0,
  ...over,
});

const show = (over: Partial<ShowFacts> = {}): ShowFacts => ({
  id: 1,
  name: 'Evening',
  hasHall: true,
  over: 0,
  hasStart: true,
  hasEnd: true,
  segments: [segment()],
  operators: 1,
  feedback: 'OPEN',
  feedbackEnabled: true,
  ...over,
});

const facts = (over: Partial<ChecklistFacts> = {}): ChecklistFacts => ({
  concertId: 7,
  hasTimezone: true,
  shows: [show()],
  templatesMissing: [],
  addresses: { suspicious: 0, unchecked: 0 },
  hasBooklet: true,
  hasPracticalInfo: true,
  ...over,
});

const items = (f: ChecklistFacts) =>
  Object.fromEntries(buildChecklist(f).flatMap((phase) => phase.items.map((i) => [i.id, i])));

describe('the setup checklist', () => {
  it('is all done for a fully set-up concert, in four phases', () => {
    const phases = buildChecklist(facts());
    expect(phases.map((p) => p.id)).toEqual(['registration', 'tickets', 'show', 'after']);
    expect(phases.flatMap((p) => p.items).filter((i) => !i.done)).toEqual([]);
  });

  it('with no shows, every show item is to do and says why, not done by vacuity', () => {
    const all = items(facts({ shows: [] }));
    for (const id of ['hall', 'start', 'segments', 'capacity', 'forms', 'design', 'operators', 'end', 'feedback']) {
      expect(all[id]!.done, id).toBe(false);
      expect(all[id]!.detail, id).toBe('No shows yet.');
    }
  });

  it('names the shows and segments that are missing something', () => {
    const all = items(
      facts({
        shows: [
          show({ id: 1, name: 'Matinee', hasHall: false, operators: 0 }),
          show({ id: 2, name: 'Evening', segments: [segment({ id: 2, name: 'Players', hasDesign: false })] }),
        ],
      }),
    );
    expect(all.hall!.detail).toBe('Missing for “Matinee”.');
    expect(all.operators!.detail).toBe('Missing for “Matinee”.');
    expect(all.design!.detail).toBe('Missing for “Evening · Players”.');
    expect(all.design!.href).toBe('/admin/concerts/7/tickets/templates');
  });

  it('a hall over-committed to segments is not done even though it has a capacity', () => {
    const all = items(facts({ shows: [show({ over: 10 })] }));
    expect(all.hall!.done).toBe(false);
    expect(all.hall!.detail).toContain('more seats in segments than the hall holds');
  });

  it('asks for a base quota only when there is a player-invited segment', () => {
    expect(items(facts()).quota).toBeUndefined();
    const all = items(
      facts({ shows: [show({ segments: [segment({ audienceMode: 'PLAYER_INVITED', hasBaseQuota: false })] })] }),
    );
    expect(all.quota!.done).toBe(false);
  });

  it('counts registration open when a form was opened, or when parties arrived by import', () => {
    const closed = items(facts({ shows: [show({ segments: [segment({ formOpened: false })] })] }));
    expect(closed.forms!.done).toBe(false);
    const imported = items(facts({ shows: [show({ segments: [segment({ formOpened: false, parties: 3 })] })] }));
    expect(imported.forms!.done).toBe(true);
  });

  it('address checks are clean only with nothing suspicious and nothing unchecked; unchecked offers the fix', () => {
    const suspicious = items(facts({ addresses: { suspicious: 2, unchecked: 0 } })).addresses!;
    expect(suspicious.done).toBe(false);
    expect(suspicious.fix).toBeUndefined();
    expect(suspicious.href).toBe('/admin/concerts/7/audience?view=suspicious-address');

    const unchecked = items(facts({ addresses: { suspicious: 0, unchecked: 1 } })).addresses!;
    expect(unchecked.done).toBe(false);
    expect(unchecked.fix).toBe('audience.check_address');
    expect(unchecked.detail).toBe('1 party has never been checked.');
  });

  it('feedback is enabled only by an open feedback form', () => {
    for (const feedback of ['none', 'DRAFT', 'CLOSED'] as const) {
      expect(items(facts({ shows: [show({ feedback })] })).feedback!.done, feedback).toBe(false);
    }
  });

  it('an open feedback form the portal hides is not feedback enabled, and says which', () => {
    const item = items(facts({ shows: [show({ feedbackEnabled: false })] })).feedback!;
    expect(item.done).toBe(false);
    expect(item.detail).toBe('The portal hides feedback for “Evening”.');
  });

  it('missing templates, booklet, practical info and timezone are each to do', () => {
    const all = items(
      facts({ templatesMissing: ['reminder'], hasBooklet: false, hasPracticalInfo: false, hasTimezone: false }),
    );
    expect([all.templates!.done, all.booklet!.done, all.practical!.done, all.timezone!.done]).toEqual([
      false,
      false,
      false,
      false,
    ]);
    expect(all.timezone!.href).toBe('/admin/concerts/7/setup');
  });
});

describe('nameList', () => {
  it('joins up to three names and counts the rest', () => {
    expect(nameList(['A'])).toBe('“A”');
    expect(nameList(['A', 'B'])).toBe('“A” and “B”');
    expect(nameList(['A', 'B', 'C', 'D', 'E'])).toBe('“A”, “B”, “C” and 2 more');
  });
});

describe('the heartbeat', () => {
  const now = new Date('2026-09-29T10:00:00Z');
  const at = (minutesAgo: number) => new Date(now.getTime() - minutesAgo * 60_000).toISOString();

  it('an unset interval means pg_cron is not scheduled, whatever ran before', () => {
    expect(heartbeatState({ startedAt: at(1), error: null }, null, now).kind).toBe('unscheduled');
  });

  it('never run, ok, stale past three ticks, failed', () => {
    expect(heartbeatState(null, 5, now).kind).toBe('never');
    expect(heartbeatState({ startedAt: at(15), error: null }, 5, now).kind).toBe('ok');
    expect(heartbeatState({ startedAt: at(16), error: null }, 5, now)).toMatchObject({ kind: 'stale', minutesAgo: 16 });
    expect(heartbeatState({ startedAt: at(2), error: 'dispatch: boom' }, 5, now)).toMatchObject({
      kind: 'failed',
      error: 'dispatch: boom',
    });
  });

  it('a late tick reads as stale even if it also failed — lateness is the bigger problem', () => {
    expect(heartbeatState({ startedAt: at(60), error: 'x' }, 5, now).kind).toBe('stale');
  });
});
