import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, sql } from '../helpers/db';
import { DEFAULT_TEMPLATES, seedDefaultTemplates } from '@/lib/email/defaults';
import { TEMPLATE_KEYS } from '@/lib/email/templates';
import { renderTemplate } from '@/lib/email/render';

beforeEach(resetDb);

describe('the seeded defaults', () => {
  it('covers every §11.3 message type', () => {
    expect(Object.keys(DEFAULT_TEMPLATES).sort()).toEqual([...TEMPLATE_KEYS].sort());
  });

  /**
   * A template that names a token which does not resolve renders an empty
   * string into the middle of a sentence, and does it to every recipient at
   * once. The seeded wording is the one set nobody reviews before a blast.
   */
  it('uses only tokens that resolve', () => {
    for (const [key, template] of Object.entries(DEFAULT_TEMPLATES)) {
      expect(renderTemplate(template.subject, {}).unknown, `${key} subject`).toEqual([]);
      expect(renderTemplate(template.bodyMd, {}).unknown, `${key} body`).toEqual([]);
    }
  });

  /**
   * `CLAUDE.md`: a number from `context.md` in a `.ts` file is a bug. Copy is
   * exempt from the cascade, but only because it states no operational value —
   * every quantity a message gives comes from a merge field.
   */
  it('states no capacity, quota or party size of its own', () => {
    for (const [key, template] of Object.entries(DEFAULT_TEMPLATES)) {
      const prose = `${template.subject}\n${template.bodyMd}`.replace(/\{\{[^}]+\}\}/g, '');
      expect(prose, `${key} hardcodes a number`).not.toMatch(/\b\d{2,}\b/);
    }
  });

  it('writes every template once', async () => {
    const first = await seedDefaultTemplates();
    expect(first.inserted).toBe(TEMPLATE_KEYS.length);

    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from email_templates`;
    expect(n).toBe(TEMPLATE_KEYS.length);
  });

  /**
   * Seeding is never an upsert. An admin's edited wording must survive a
   * redeploy and the next person who runs this without reading it — module `E`
   * records the same rule for ticket templates.
   */
  it('never overwrites wording an admin has edited', async () => {
    await seedDefaultTemplates();
    await sql`update email_templates set subject = 'Edited by the committee' where key = 'public_ticket'`;

    const second = await seedDefaultTemplates();

    expect(second.inserted).toBe(0);
    const [row] = await sql<{ subject: string }[]>`
      select subject from email_templates where key = 'public_ticket'
    `;
    expect(row.subject).toBe('Edited by the committee');
  });
});
