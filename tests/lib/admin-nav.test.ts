import { describe, expect, it } from 'vitest';
import { AREAS, concertPath, locate } from '@/app/(admin)/admin/nav';

/** The seven areas (spec/v3.md §29.1) and how a path finds its area and tab. */

describe('the console navigation', () => {
  it('has the seven areas of §29.1, in order', () => {
    expect(AREAS.map((area) => area.label)).toEqual([
      'Home',
      'Audience',
      'Inbox',
      'Intake',
      'Door',
      'After',
      'Setup',
    ]);
  });

  it('gives every screen exactly one area', () => {
    const slugs = AREAS.flatMap((area) => area.tabs.map((tab) => tab.slug));
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it.each([
    ['home', 'home', 'home'],
    ['audience', 'audience', 'audience'],
    ['audience/12', 'audience', 'audience'],
    ['audience/messages', 'audience', 'audience/messages'],
    ['inbox/4', 'inbox', 'inbox'],
    ['forms/3/responses', 'intake', 'forms'],
    ['import/9', 'intake', 'import'],
    ['checkin', 'door', 'checkin'],
    ['operators', 'door', 'operators'],
    ['feedback', 'after', 'feedback'],
    ['notes', 'after', 'notes'],
    ['portal', 'after', 'portal'],
    ['setup', 'setup', 'setup'],
    ['shows', 'setup', 'shows'],
    ['players', 'setup', 'players'],
    ['tickets/templates/5', 'setup', 'tickets/templates'],
    ['email/templates', 'setup', 'email/templates'],
  ])('%s is %s › %s', (rest, area, tab) => {
    const here = locate(rest);
    expect(here?.kind).toBe('area');
    if (here?.kind !== 'area') return;
    expect(here.area.id).toBe(area);
    expect(here.tab.slug).toBe(tab);
  });

  it('does not take a prefix that is not a whole segment', () => {
    expect(locate('audiences')).toBeNull();
    expect(locate('homework')).toBeNull();
  });

  it('puts Activity and Trash in the records, outside the areas', () => {
    expect(locate('activity')).toMatchObject({ kind: 'record', item: { label: 'Activity' } });
    expect(locate('trash')).toMatchObject({ kind: 'record', item: { label: 'Trash' } });
  });

  it('reads the concert and the rest from a pathname', () => {
    expect(concertPath('/admin/concerts/3/audience/12')).toEqual({ concertId: 3, rest: 'audience/12' });
    expect(concertPath('/admin/concerts/3')).toEqual({ concertId: 3, rest: '' });
    expect(concertPath('/admin/concerts')).toBeNull();
    expect(concertPath('/admin/settings')).toBeNull();
  });
});
