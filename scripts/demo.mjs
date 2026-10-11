/**
 * The demo, locally, in one command (spec/v3.md §31).
 *
 *   docker start zetix-test    # or any local Postgres 16 on :55432
 *   pnpm demo
 *
 * Creates and migrates the `zetix_demo` database if it has to, starts the QA
 * Auth stub, seeds the demo with `--reset`, then runs `next dev` on it. Ctrl+C
 * stops both. The stub keeps its users in memory, which is why every start
 * seeds again: a reset is cheap and leaves nothing stale.
 *
 * **Nothing in `.env.local` reaches the demo.** That file holds production's
 * database, Supabase project, Gmail account and admin code. Every key it
 * defines is overridden here — by the demo's own value, or else by an empty
 * string — and neither dotenv nor Next ever fills a variable that is set, even
 * to nothing. So a key added to `.env.local` later is blanked too, without
 * anyone remembering to list it. And the database must be local: the seed's
 * guard already refuses a database it did not mark, and this refuses to try.
 *
 * Overrides, all optional: DEMO_DATABASE_URL, DEMO_PORT (3100),
 * DEMO_STUB_PORT (54329), DEMO_ADMIN_PASSWORD, DEMO_VIEWER_PASSWORD,
 * DEMO_OPERATOR_CODE.
 *
 * **DEMO_SMTP_PORT** sends the demo's mail to a catcher on that port of
 * 127.0.0.1 — Mailpit, say (`docker run -p 1025:1025 -p 8025:8025
 * axllent/mailpit`) — so a send can be watched arriving. Only ever
 * 127.0.0.1, and with no password the inbox stays unconfigured. Unset, the
 * demo has no mailbox at all and every send fails closed.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'dotenv';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

const require = createRequire(import.meta.url);
const TSX_CLI = require.resolve('tsx/cli');
const NEXT_CLI = require.resolve('next/dist/bin/next');

const DATABASE_URL = process.env.DEMO_DATABASE_URL ?? 'postgresql://postgres@localhost:55432/zetix_demo';
const PORT = Number(process.env.DEMO_PORT ?? 3100);
const STUB_PORT = Number(process.env.DEMO_STUB_PORT ?? 54329);
const PASSWORDS = {
  admin: process.env.DEMO_ADMIN_PASSWORD || 'demo-admin-pass',
  viewer: process.env.DEMO_VIEWER_PASSWORD || 'demo-viewer-pass',
  operator: process.env.DEMO_OPERATOR_CODE || 'demo-usher-code',
};
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function fail(message) {
  console.error(`pnpm demo: ${message}`);
  process.exit(1);
}

const target = new URL(DATABASE_URL);
if (!LOCAL_HOSTS.has(target.hostname)) {
  fail(`refusing a non-local database (${target.hostname}). The demo runs on a local Postgres only.`);
}

// ── The environment ───────────────────────────────────────────────────────────

const assets = join(tmpdir(), 'zetix-demo');
mkdirSync(join(assets, 'tickets'), { recursive: true });
mkdirSync(join(assets, 'forms'), { recursive: true });

const DEMO_ENV = {
  DATABASE_URL,
  DIRECT_URL: DATABASE_URL,
  QA_DATABASE_URL: DATABASE_URL,
  NEXT_PUBLIC_SUPABASE_URL: `http://127.0.0.1:${STUB_PORT}`,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'stub',
  SUPABASE_SERVICE_ROLE_KEY: 'stub',
  APP_URL: `http://localhost:${PORT}`,
  CRON_SECRET: 'demo',
  TICKET_ASSET_DIR: join(assets, 'tickets'),
  FORM_ASSET_DIR: join(assets, 'forms'),
  DEMO_ADMIN_PASSWORD: PASSWORDS.admin,
  DEMO_VIEWER_PASSWORD: PASSWORDS.viewer,
  DEMO_OPERATOR_CODE: PASSWORDS.operator,
  STUB_PORT: String(STUB_PORT),
  STUB_USERS: '[]',
};

const SMTP_PORT = process.env.DEMO_SMTP_PORT ? Number(process.env.DEMO_SMTP_PORT) : null;
if (SMTP_PORT !== null) {
  if (!(SMTP_PORT > 0)) fail(`DEMO_SMTP_PORT is not a port: ${process.env.DEMO_SMTP_PORT}`);
  Object.assign(DEMO_ENV, {
    GMAIL_USER: 'tickets@example.org',
    SMTP_HOST: '127.0.0.1',
    SMTP_PORT: String(SMTP_PORT),
    SMTP_SECURE: 'false',
  });
}

/** Every key the env files define and the demo does not, set to nothing. */
const blanked = {};
for (const file of ['.env.local', '.env']) {
  if (!existsSync(file)) continue;
  for (const key of Object.keys(parse(readFileSync(file)))) {
    if (!(key in DEMO_ENV)) blanked[key] = '';
  }
}
// The ones that send mail or sign in as someone are blanked even if no file names them.
for (const key of ['GMAIL_USER', 'GMAIL_APP_PASSWORD', 'SMTP_HOST', 'IMAP_HOST', 'BOOTSTRAP_ADMIN_PASSWORD', 'VERCEL_OIDC_TOKEN']) {
  blanked[key] = '';
}

const env = { ...process.env, ...blanked, ...DEMO_ENV };

// ── The database ──────────────────────────────────────────────────────────────

async function prepareDatabase() {
  const name = target.pathname.slice(1);
  const admin = new URL(DATABASE_URL);
  admin.pathname = '/postgres';
  const server = postgres(admin.href, { prepare: false, max: 1, onnotice: () => {} });
  try {
    await server`select 1`;
  } catch (error) {
    fail(`cannot reach Postgres at ${target.host} (${error.code ?? error.message}). Is Docker running? Try \`docker start zetix-test\`.`);
  }
  const [exists] = await server`select 1 from pg_database where datname = ${name}`;
  if (!exists) {
    await server.unsafe(`create database "${name.replace(/"/g, '""')}"`);
    console.log(`Created the ${name} database.`);
  }
  await server.end();

  const sql = postgres(DATABASE_URL, { prepare: false, max: 1, onnotice: () => {} });
  await sql.unsafe(readFileSync('scripts/db-extensions.sql', 'utf8'));
  await migrate(drizzle(sql), { migrationsFolder: './drizzle' });
  await sql.end();
}

// ── The Auth stub ─────────────────────────────────────────────────────────────

function waitForPort(port, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = connect(port, '127.0.0.1');
      socket.once('connect', () => {
        socket.end();
        resolve();
      });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() > deadline) reject(new Error(`nothing listening on :${port}`));
        else setTimeout(attempt, 150);
      });
    };
    attempt();
  });
}

const children = [];
function stopAll() {
  for (const child of children) if (child.exitCode === null) child.kill();
}
process.on('SIGINT', stopAll);
process.on('SIGTERM', stopAll);
process.on('exit', stopAll);

/**
 * A port still held by an earlier demo is refused up front. Otherwise the new
 * stub fails to bind while the seed talks to the *old* one, and the run dies
 * after the seed with a message about the wrong thing.
 */
async function requireFree(port, what) {
  const taken = await waitForPort(port, 0).then(() => true, () => false);
  if (taken) fail(`:${port} is in use, so the ${what} cannot start. Is an earlier \`pnpm demo\` still running?`);
}

// ── Run ───────────────────────────────────────────────────────────────────────

await requireFree(STUB_PORT, 'Auth stub');
await requireFree(PORT, 'app');
await prepareDatabase();

const stub = spawn(process.execPath, ['qa/support/gotrue-stub.mjs'], { env, stdio: ['ignore', 'ignore', 'inherit'] });
children.push(stub);
stub.once('exit', (code) => {
  if (code !== null && code !== 0) fail(`the Auth stub exited (${code}). Is something else on :${STUB_PORT}?`);
});
await waitForPort(STUB_PORT).catch((error) => fail(`the Auth stub did not start: ${error.message}`));

const seed = spawnSync(process.execPath, [TSX_CLI, '--conditions=react-server', 'scripts/seed-demo.ts', '--reset'], {
  env,
  stdio: 'inherit',
});
if (seed.status !== 0) {
  stopAll();
  fail('the seed failed (above).');
}

console.log(`
  The demo is on ${DEMO_ENV.APP_URL}
    admin   admin@example.org    ${PASSWORDS.admin}
    viewer  visitor@example.org  ${PASSWORDS.viewer}
    ushers  aisyah, jun-hao, priya — access code ${PASSWORDS.operator}${SMTP_PORT ? `
    mail    to the catcher on 127.0.0.1:${SMTP_PORT}` : ''}
`);

const next = spawn(process.execPath, [NEXT_CLI, 'dev', '-p', String(PORT)], { env, stdio: 'inherit' });
children.push(next);
next.once('exit', (code) => {
  stopAll();
  process.exit(code ?? 0);
});
