import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, sql } from '../helpers/db';
import { seedDefaultTemplates } from '@/lib/email/defaults';
import { DEFAULT_TEMPLATES } from '@/lib/email/default-templates';
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

describe('the copy is importable from plain Node', () => {
  /**
   * **`scripts/seed-email-templates.ts` runs under `tsx`, not Next.**
   *
   * `defaults.ts` carries `import 'server-only'`, which throws outside a server
   * component — so the script cannot import from it, and the wording lives in
   * `default-templates.ts` with no such import. That is not a style choice: the
   * script failed at startup until they were split.
   *
   * This test fails if `server-only` is ever added to the data module, or if the
   * script's import is pointed back at `defaults.ts` — either of which breaks
   * seeding production and would otherwise only be discovered by running it.
   */
  it('has no server-only import in the data module or the script', async () => {
    const { readFileSync } = await import('node:fs');

    const data = readFileSync('src/lib/email/default-templates.ts', 'utf8');
    expect(data, 'default-templates.ts must stay importable from a plain Node script').not.toMatch(
      /["']server-only["']/,
    );

    const script = readFileSync('scripts/seed-email-templates.ts', 'utf8');
    expect(script, 'the script must import the data module, not the server-only one').toContain(
      "from '../src/lib/email/default-templates'",
    );
    expect(script).not.toContain("from '../src/lib/email/defaults'");
  });

  /** The seeded set and the writer must not drift apart across the split. */
  it('seeds exactly the templates the data module declares', async () => {
    const result = await seedDefaultTemplates();
    expect(result.inserted).toBe(Object.keys(DEFAULT_TEMPLATES).length);
  });
});
