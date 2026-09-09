/**
 * A standalone local SMTP sink for module `F`'s browser pass.
 *
 * SMTP to Gmail is blocked from any container and the app password is
 * deliberately absent (`docs/local.md` §7), so the browser flows send into this
 * instead. It speaks the real protocol, so `AUTH`, `MAIL FROM`, `RCPT TO` and
 * the `DATA` bytes are all genuine — which is everything the blast's
 * idempotency claim needs, because "pressing Send twice is harmless" is a
 * database property and "one message per registration" is a composer property.
 *
 * Received messages are appended to a JSONL file and also served over a tiny
 * HTTP endpoint so a Playwright spec can count them.
 */
import { createServer } from 'node:http';
import { appendFileSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { SMTPServer } from 'smtp-server';

const SMTP_PORT = Number(process.env.SMTP_SINK_PORT ?? process.env.SMTP_PORT ?? 2526);
const HTTP_PORT = Number(process.env.SMTP_SINK_HTTP_PORT ?? 2527);
const LOG = process.env.SMTP_SINK_LOG ?? '/tmp/qa-f-sink.jsonl';

writeFileSync(LOG, '');
let connections = 0;

const server = new SMTPServer({
  authOptional: true,
  disabledCommands: ['STARTTLS'],
  onConnect(_session, cb) {
    connections += 1;
    cb();
  },
  onAuth(auth, _session, cb) {
    cb(null, { user: auth.username });
  },
  onData(stream, session, cb) {
    const chunks = [];
    stream.on('data', (c) => chunks.push(c));
    stream.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const header = raw.split(/\r?\n\r?\n/)[0] ?? '';
      const subject = /^Subject:\s*(.*)$/im.exec(header)?.[1]?.trim() ?? '';
      // One `Content-Disposition: attachment` per PDF, merged or not.
      const attachments = (raw.match(/Content-Disposition:\s*attachment/gi) ?? []).length;
      const filenames = [...raw.matchAll(/filename="?([^"\r\n;]+)"?/gi)].map((m) => m[1]);
      appendFileSync(
        LOG,
        JSON.stringify({
          at: new Date().toISOString(),
          mailFrom: session.envelope.mailFrom && session.envelope.mailFrom.address,
          rcptTo: session.envelope.rcptTo.map((r) => r.address),
          subject,
          attachments,
          filenames,
          bytes: raw.length,
        }) + '\n',
      );
      cb();
    });
  },
});

server.listen(SMTP_PORT, '127.0.0.1', () => {
  console.log(`smtp sink on 127.0.0.1:${SMTP_PORT}`);
});

createServer((req, res) => {
  if (req.url === '/reset') {
    writeFileSync(LOG, '');
    connections = 0;
    res.writeHead(200).end('{"ok":true}');
    return;
  }
  const lines = existsSync(LOG)
    ? readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : [];
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ connections, count: lines.length, messages: lines }));
}).listen(HTTP_PORT, '127.0.0.1', () => {
  console.log(`sink inspector on http://127.0.0.1:${HTTP_PORT}`);
});
