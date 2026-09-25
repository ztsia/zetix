import { describe, expect, it } from 'vitest';
import { maskContacts, maskEmail, maskForRole, maskPhone } from '@/lib/auth/mask';

/**
 * The viewer's mask (spec/v3.md §28). What must never survive it is a whole
 * address or phone number, or a ticket's key; what must survive it is
 * everything else a screen needs to render.
 */

describe('maskEmail / maskPhone', () => {
  it('keeps enough to tell rows apart and not enough to write to', () => {
    expect(maskEmail('zhong@example.com')).toBe('z•••@e•••.com');
    expect(maskEmail('not-an-address')).toBe('•••');
    expect(maskEmail('')).toBe('');
    expect(maskPhone('+65 9123 4567')).toBe('•••67');
    expect(maskPhone('')).toBe('');
  });
});

describe('maskContacts', () => {
  const row = {
    id: 42,
    contactName: 'Tan Wei Ling',
    contactEmail: 'weiling@example.com',
    contact_phone: '+65 9123 4567',
    email: 'typo-without-at',
    emailIssue: 'SUSPICIOUS_ADDRESS',
    status: 'CONFIRMED',
    seats: { confirmed: 2 },
    createdAt: new Date('2026-09-01T00:00:00Z'),
    inviteToken: 'abcDEF123_-',
    subject: 'Your tickets for Show 1',
    bodyMd: 'Hi — reply to committee@example.org.\n\n- Ana — [View ticket](https://x.test/t/AbC123_-x)',
    audit: { before: { contact_email: 'old@example.net' }, after: null },
    tags: ['one', 'two@example.com'],
  };

  it('masks every contact detail, wherever it sits', () => {
    const masked = maskContacts(row);
    const text = JSON.stringify(masked);
    for (const secret of [
      'weiling@example.com',
      '9123 4567',
      'typo-without-at',
      'committee@example.org',
      'old@example.net',
      'two@example.com',
      'abcDEF123_-',
      'AbC123_-x',
    ]) {
      expect(text).not.toContain(secret);
    }
    expect(masked.contactEmail).toBe('w•••@e•••.com');
    expect(masked.contact_phone).toBe('•••67');
    expect(masked.bodyMd).toContain('/t/•••');
  });

  it('leaves everything else exactly as it was', () => {
    const masked = maskContacts(row);
    expect(masked.id).toBe(42);
    expect(masked.contactName).toBe('Tan Wei Ling');
    expect(masked.emailIssue).toBe('SUSPICIOUS_ADDRESS');
    expect(masked.status).toBe('CONFIRMED');
    expect(masked.seats).toEqual({ confirmed: 2 });
    expect(masked.createdAt).toBeInstanceOf(Date);
    expect(masked.subject).toBe('Your tickets for Show 1');
    expect(masked.tags[0]).toBe('one');
  });

  it('does not change its input', () => {
    const copy = structuredClone(row);
    maskContacts(row);
    expect(row).toEqual(copy);
  });
});

describe('maskForRole', () => {
  it('masks for a viewer and for nobody else', () => {
    const data = { email: 'a@b.co' };
    expect(maskForRole('VIEWER', data).email).not.toBe('a@b.co');
    expect(maskForRole('ADMIN', data)).toBe(data);
  });
});
