/**
 * A stand-in Supabase Auth (GoTrue) server for QA only.
 *
 * There is no SUPABASE_SERVICE_ROLE_KEY in a cloud container (docs/local.md §7),
 * so a real ADMIN/OPERATOR cannot be created in the live project. This speaks
 * enough of the GoTrue wire protocol for @supabase/ssr to sign in, refresh and
 * revalidate, so the *application's own* authorization code runs unmodified.
 *
 * Nothing under src/ is touched: only NEXT_PUBLIC_SUPABASE_URL is repointed.
 */
import { createServer } from 'node:http';
import { createHmac, randomUUID } from 'node:crypto';

const PORT = Number(process.env.STUB_PORT ?? 54321);
const USERS = JSON.parse(process.env.STUB_USERS ?? '[]'); // [{id,email,password}]

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function jwt(user, ttl = 3600) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64({
    sub: user.id, email: user.email, aud: 'authenticated', role: 'authenticated',
    iat: now, exp: now + ttl, session_id: randomUUID(),
  });
  const sig = createHmac('sha256', 'qa-stub-secret').update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}
const shape = (u) => ({
  id: u.id, aud: 'authenticated', role: 'authenticated', email: u.email,
  email_confirmed_at: '2026-01-01T00:00:00Z', phone: '',
  confirmed_at: '2026-01-01T00:00:00Z', last_sign_in_at: new Date().toISOString(),
  app_metadata: { provider: 'email', providers: ['email'] },
  user_metadata: {}, identities: [], created_at: '2026-01-01T00:00:00Z',
  updated_at: new Date().toISOString(), is_anonymous: false,
});
const sessions = new Map(); // access_token -> user
const refreshes = new Map(); // refresh_token -> user

function session(u) {
  const access_token = jwt(u);
  const refresh_token = randomUUID();
  sessions.set(access_token, u);
  refreshes.set(refresh_token, u);
  return {
    access_token, token_type: 'bearer', expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    refresh_token, user: shape(u),
  };
}

const json = (res, code, obj) => {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
};

let calls = [];
createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString();
  let body = {};
  try { body = raw ? JSON.parse(raw) : {}; } catch {}
  calls.push({ method: req.method, path: url.pathname, grant: url.searchParams.get('grant_type') });

  if (url.pathname === '/__qa/calls') return json(res, 200, calls);
  if (url.pathname === '/__qa/reset') { calls = []; return json(res, 200, { ok: true }); }

  if (url.pathname === '/auth/v1/settings') {
    return json(res, 200, { disable_signup: true, mailer_autoconfirm: false, external: {} });
  }
  if (url.pathname === '/auth/v1/signup') {
    return json(res, 422, { code: 422, error_code: 'signup_disabled', msg: 'Signups not allowed for this instance' });
  }
  if (url.pathname === '/auth/v1/token') {
    const grant = url.searchParams.get('grant_type');
    if (grant === 'password') {
      const u = USERS.find((x) => x.email === body.email && x.password === body.password);
      if (!u) return json(res, 400, { code: 400, error_code: 'invalid_credentials', msg: 'Invalid login credentials' });
      return json(res, 200, session(u));
    }
    if (grant === 'refresh_token') {
      const u = refreshes.get(body.refresh_token);
      if (!u) return json(res, 400, { code: 400, error_code: 'refresh_token_not_found', msg: 'Invalid Refresh Token' });
      return json(res, 200, session(u));
    }
    return json(res, 400, { msg: 'unsupported grant' });
  }
  if (url.pathname === '/auth/v1/user') {
    const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
    const u = sessions.get(token);
    if (!u) return json(res, 401, { code: 401, error_code: 'bad_jwt', msg: 'invalid claim: missing sub claim' });
    return json(res, 200, shape(u));
  }
  // --- admin API (service-role), for scripts/bootstrap-admin.ts ------------
  if (url.pathname === '/auth/v1/admin/users' && req.method === 'GET') {
    return json(res, 200, { users: USERS.map(shape), aud: 'authenticated' });
  }
  if (url.pathname === '/auth/v1/admin/users' && req.method === 'POST') {
    if (USERS.some((u) => u.email === body.email)) {
      return json(res, 422, { code: 422, error_code: 'email_exists', msg: 'A user with this email address has already been registered' });
    }
    const u = { id: randomUUID(), email: body.email, password: body.password };
    USERS.push(u);
    return json(res, 200, shape(u));
  }
  if (url.pathname.startsWith('/auth/v1/admin/users/') && req.method === 'PUT') {
    const id = url.pathname.split('/').pop();
    const u = USERS.find((x) => x.id === id);
    if (!u) return json(res, 404, { msg: 'user not found' });
    if (body.password) u.password = body.password;
    return json(res, 200, shape(u));
  }
  if (url.pathname === '/auth/v1/logout') { res.writeHead(204); return res.end(); }
  return json(res, 404, { msg: `no stub route for ${url.pathname}` });
}).listen(PORT, () => console.log(`gotrue-stub on :${PORT} with ${USERS.length} users`));
