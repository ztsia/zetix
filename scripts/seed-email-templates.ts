/**
 * Install seed for `email_templates` — the eight §11.3 message types.
 *
 * **The app already seeds these lazily**, on the first visit to
 * `/admin/concerts/{id}/email/templates` and before every blast is prepared, so
 * nothing is broken without this script. It exists because seeding through the
 * UI means opening the console against production to make a write happen, and
 * because "run this once after the migration" is a better instruction for a
 * local session than "click into a screen and trust that it fired".
 *
 * **Idempotent, and never an upsert.** Re-running it does not overwrite wording
 * an admin has since edited — the same rule module `E` records for ticket
 * templates, and the failure it prevents is the committee's rewritten player
 * email silently reverting on a redeploy. There is deliberately **no `--force`**,
 * unlike `seed-settings.ts`: a settings value is a number that can be re-entered
 * in a minute, whereas the wording of eighty players' invitations is not, and a
 * flag that restores factory copy is one keystroke from destroying it.
 *
 *   pnpm db:seed:email
 *
 * Reads `DATABASE_URL`, so point it at the same database `pnpm db:migrate` just
 * ran against. Migration `0006` must be applied first — the table has to exist.
 */
import './load-env';
import { getSql } from '../src/db/client';
import { DEFAULT_TEMPLATES } from '../src/lib/email/default-templates';

async function main() {
  if (process.argv.includes('--force')) {
    console.error(
      'There is no --force here, deliberately. It would overwrite wording the ' +
        'committee has edited, and unlike a settings value that is not something ' +
        'you can retype in a minute. Edit a template in the admin UI instead.',
    );
    process.exit(1);
  }

  const sql = getSql();
  const entries = Object.entries(DEFAULT_TEMPLATES);
  let written = 0;

  for (const [key, template] of entries) {
    const result = await sql`
      insert into email_templates (key, name, subject, body_md)
      values (${key}, ${template.name}, ${template.subject}, ${template.bodyMd})
      on conflict (key) do nothing
      returning key
    `;
    written += result.length;
  }

  console.log(
    `email_templates: ${written} of ${entries.length} templates written` +
      (written === entries.length ? '' : ' (existing wording left alone)'),
  );
  console.log('Review and edit them in Admin → Email → Edit templates before the first blast.');
  await sql.end();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
