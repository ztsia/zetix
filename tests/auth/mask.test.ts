import { describe, expect, it } from 'vitest';
import { maskContacts, maskEmail, maskForRole, maskPhone, maskPhonesInText } from '@/lib/auth/mask';

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

describe('free text a record shows a viewer (module S QA)', () => {
  it('masks an address whose domain has no dot', () => {
    const masked = maskContacts({ lastError: '550 no such user alice@examplecom' });
    expect(masked.lastError).not.toContain('alice@examplecom');
  });

  it('withholds every credential link the system mails out, not only /t/', () => {
    const masked = maskContacts({
      text: [
        '> Change your answers: https://x.test/f/round-2/edit?r=EDITSECRET000000000001',
        '> Confirm your address: https://x.test/f/verify?t=VERSECRET000000000001',
        '> Your invite: https://x.test/f/players?k=seedtoken0000000000001&x=1',
        '> Update: https://x.test/p?update_token=UPDSECRET01',
      ].join('\n'),
    });
    for (const secret of ['EDITSECRET000000000001', 'VERSECRET000000000001', 'seedtoken0000000000001', 'UPDSECRET01']) {
      expect(masked.text).not.toContain(secret);
    }
    expect(masked.text).toContain('&x=1');
  });

  it('maskPhonesInText masks phone numbers in prose and leaves short numbers alone', () => {
    const text = maskPhonesInText('Call +60 17-313 1313 about the 2 seats in row 14');
    expect(text).not.toContain('313 1313');
    expect(text).toContain('•••13');
    expect(text).toContain('2 seats in row 14');
  });
});
