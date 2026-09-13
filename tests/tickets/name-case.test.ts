import { describe, expect, it } from 'vitest';
import { toNameCase } from '@/lib/tickets/name-case';

/**
 * Names are typed by whoever filled in the form, and the ticket is where that
 * shows. The rules are in `name-case.ts`; these pin the cases that made them
 * necessary.
 */
describe('names that carry no capitalisation of their own', () => {
  it('title-cases a name shouted in caps', () => {
    expect(toNameCase('LOH KAI XIN')).toBe('Loh Kai Xin');
  });

  it('title-cases a name typed entirely in lowercase', () => {
    expect(toNameCase('amir hakim bin abdul rashid')).toBe('Amir Hakim bin Abdul Rashid');
  });

  it('capitalises across a hyphen and an apostrophe', () => {
    expect(toNameCase('JING-WEI')).toBe('Jing-Wei');
    expect(toNameCase("O'BRIEN")).toBe("O'Brien");
  });

  it('keeps initials as initials', () => {
    expect(toNameCase('A.B. TAN')).toBe('A.B. Tan');
  });
});

describe('names that were typed correctly', () => {
  /**
   * The rule that does most of the work. A token carrying both cases was a
   * decision, and a decision beats a rule — otherwise this "fix" would turn
   * McDonald into Mcdonald on the day the tickets print.
   */
  it('leaves a mixed-case token exactly alone', () => {
    expect(toNameCase('McDonald')).toBe('McDonald');
    expect(toNameCase('DeSilva')).toBe('DeSilva');
    expect(toNameCase('Loh Kai Xin')).toBe('Loh Kai Xin');
  });

  it('still fixes an all-caps token beside a decided one', () => {
    expect(toNameCase('McDonald TAN')).toBe('McDonald Tan');
  });

  it('reads Mc as Mc when the whole token is caps', () => {
    expect(toNameCase('MCDONALD')).toBe('McDonald');
  });

  /**
   * Mac is deliberately not special-cased: Macaulay, Mackenzie and MacArthur
   * are all correct spellings and no rule chooses between them.
   */
  it('does not guess at Mac', () => {
    expect(toNameCase('MACAULAY')).toBe('Macaulay');
  });
});

describe('particles', () => {
  it('keeps them lowercase inside the name', () => {
    expect(toNameCase('NUR AISYAH BINTI ALI')).toBe('Nur Aisyah binti Ali');
    expect(toNameCase('LUIS DE LA CRUZ')).toBe('Luis de la Cruz');
  });

  it('capitalises one that opens the name', () => {
    expect(toNameCase('DE SILVA')).toBe('De Silva');
  });

  /**
   * The generated placeholder for an unnamed seat (decision 32). "Guest Of Tan
   * Wei" is exactly the detail that makes a ticket look machine-made.
   */
  it('leaves the unnamed-seat placeholder reading like English', () => {
    expect(toNameCase('Guest of Tan Wei')).toBe('Guest of Tan Wei');
    expect(toNameCase('GUEST OF TAN WEI')).toBe('Guest of Tan Wei');
  });
});

describe('scripts with no case', () => {
  it('returns a Chinese name untouched', () => {
    expect(toNameCase('陈大文')).toBe('陈大文');
  });

  it('fixes only the part that has a case', () => {
    expect(toNameCase('陈大文 TAN')).toBe('陈大文 Tan');
  });

  it('preserves the spacing it was given', () => {
    expect(toNameCase('  YAP   JING WEI ')).toBe('  Yap   Jing Wei ');
  });
});
