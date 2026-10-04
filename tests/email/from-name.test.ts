import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetDb, sql } from '../helpers/db';
import { startSmtpSink, type Sink } from '../helpers/smtp-sink';
import { settingSpec } from '@/app/(admin)/admin/settings/catalogue';
import { createStreamTransport } from '@/lib/mail/transport';

/**
 * The name every message is sent under is the `email.from_name` setting
 * (spec/v3.md §31), not a constant: it is the organisation's, and an install
 * for another orchestra must not send as the first one.
 *
 * End to end through `createConfiguredTransport()` and a real SMTP sink, so
 * what is asserted is the `From:` header a recipient's client shows. One sink
 * for the file: `env()` caches, so the port it first reads is the port it keeps.
 */
const TSX_CLI = fileURLToPath(import.meta.resolve('tsx/cli'));
const MAILBOX = 'tickets@example.org';

let sink: Sink;

const message = {
  to: 'guest@example.test',
  subject: 'Your tickets',
  html: '<p>Hello</p>',
  text: 'Hello',
};

async function fromHeaderSent(): Promise<string> {
  sink.messages.length = 0;
  const { createConfiguredTransport } = await import('@/lib/email/config');
  const transport = await createConfiguredTransport();
  try {
    await transport.send(message);
  } finally {
    await transport.close();
  }
  return sink.messages[0].raw.toString('utf8').match(/^From:.*/m)?.[0] ?? '';
}

async function setFromName(value: unknown) {
  await sql`
    insert into system_settings (key, value)
    values ('email.from_name', ${JSON.stringify(value)}::text::jsonb)
    on conflict (key) do update set value = excluded.value
  `;
}

beforeAll(async () => {
  sink = await startSmtpSink();
  process.env.GMAIL_USER = MAILBOX;
  process.env.SMTP_HOST = '127.0.0.1';
  process.env.SMTP_PORT = String(sink.port);
  process.env.SMTP_SECURE = 'false';
});

afterAll(async () => {
  await sink.close();
});

beforeEach(async () => {
  await resetDb();
});

describe('the sender name', () => {
  it('signs every message with the setting', async () => {
    await setFromName('Lakeside Community Orchestra');
    expect(await fromHeaderSent()).toMatch(/^From: "?Lakeside Community Orchestra"? <tickets@example\.org>$/);
  });

  it('sends from the address alone when nobody has set it', async () => {
    expect(await fromHeaderSent()).toBe(`From: ${MAILBOX}`);
  });

  it('treats a blank name as unset rather than sending an empty one', async () => {
    await setFromName('   ');
    expect(await fromHeaderSent()).toBe(`From: ${MAILBOX}`);
  });

  it('composes a bare address when the transport has no name', async () => {
    const result = await createStreamTransport(null, MAILBOX).send(message);
    expect(result.raw?.toString('utf8').match(/^From:.*/m)?.[0]).toBe(`From: ${MAILBOX}`);
  });

  it('is listed for an admin at system level', () => {
    expect(settingSpec('email.from_name')).toMatchObject({ kind: 'text', operational: false, level: 'system' });
  });

  it('is never seeded: the name is the organisation’s data, not the runtime’s', async () => {
    execFileSync(process.execPath, [TSX_CLI, 'scripts/seed-settings.ts'], {
      encoding: 'utf8',
      env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL },
    });
    const rows = await sql`select 1 from system_settings where key = 'email.from_name'`;
    expect(rows).toHaveLength(0);
  });
});
