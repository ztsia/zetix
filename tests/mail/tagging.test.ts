import { describe, expect, it } from 'vitest';
import {
  findPlusTag,
  makeMessageId,
  normalizeMessageId,
  parseMessageIdList,
  parsePlusTag,
  plusAddress,
} from '@/lib/mail/tagging';

/** spec/v3.md §26.2: the two tags every outgoing message carries. */

const MAILBOX = 'Events@Example.org';

describe('makeMessageId', () => {
  it('names the outbox row, adds randomness, and uses the sender domain', () => {
    const a = makeMessageId(41, MAILBOX);
    const b = makeMessageId(41, MAILBOX);
    expect(a).toMatch(/^<41\.[0-9a-f]{16}@example\.org>$/);
    // The random half is what keeps a restored database from reusing an id a guest has seen.
    expect(a).not.toBe(b);
  });

  it('refuses a sender that is not an address', () => {
    expect(() => makeMessageId(1, 'not-an-address')).toThrow();
  });
});

describe('plus addresses', () => {
  it('tags registrations with p and players with pl, and reads both back', () => {
    const party = plusAddress(MAILBOX, { kind: 'registration', id: 42 });
    const player = plusAddress(MAILBOX, { kind: 'player', id: 7 });
    expect(party).toBe('Events+p42@Example.org');
    expect(player).toBe('Events+pl7@Example.org');
    expect(parsePlusTag(party, MAILBOX)).toEqual({ kind: 'registration', id: 42 });
    expect(parsePlusTag(player, MAILBOX)).toEqual({ kind: 'player', id: 7 });
  });

  it('replaces a tag the mailbox itself already carries rather than stacking a second', () => {
    expect(plusAddress('events+zetix@example.org', { kind: 'registration', id: 3 })).toBe('events+p3@example.org');
  });

  it('matches case-insensitively, as mail does', () => {
    expect(parsePlusTag('EVENTS+P42@EXAMPLE.ORG', MAILBOX)).toEqual({ kind: 'registration', id: 42 });
  });

  it("ignores a plus tag on somebody else's mailbox", () => {
    expect(parsePlusTag('events+p42@elsewhere.example', MAILBOX)).toBeNull();
    expect(parsePlusTag('someone+p42@example.org', MAILBOX)).toBeNull();
  });

  it('ignores tags that are not ours', () => {
    for (const address of [
      'events@example.org',
      'events+news@example.org',
      'events+p@example.org',
      'events+p0@example.org',
      'events+p12x@example.org',
      'events+q12@example.org',
    ]) {
      expect(parsePlusTag(address, MAILBOX), address).toBeNull();
    }
  });

  it('finds the tagged address among several recipients', () => {
    expect(
      findPlusTag(['someone@else.example', 'events+pl9@example.org'], MAILBOX),
    ).toEqual({ kind: 'player', id: 9 });
    expect(findPlusTag(['events@example.org'], MAILBOX)).toBeNull();
  });
});

describe('message id normalisation', () => {
  it('brackets, trims, and rejects what is not an id', () => {
    expect(normalizeMessageId(' <a.b@c> ')).toBe('<a.b@c>');
    expect(normalizeMessageId('a.b@c')).toBe('<a.b@c>');
    expect(normalizeMessageId('(comment) <a.b@c>')).toBe('<a.b@c>');
    expect(normalizeMessageId('')).toBeNull();
    expect(normalizeMessageId(null)).toBeNull();
    expect(normalizeMessageId('no at sign')).toBeNull();
  });

  it('reads a References header in order, without duplicates', () => {
    expect(parseMessageIdList('<a@x> <b@x>\r\n <a@x>')).toEqual(['<a@x>', '<b@x>']);
    expect(parseMessageIdList(['<a@x>', '<c@x>'])).toEqual(['<a@x>', '<c@x>']);
    expect(parseMessageIdList(undefined)).toEqual([]);
  });
});
