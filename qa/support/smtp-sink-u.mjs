/** SMTP sink for module U's browser pass: like smtp-sink.mjs, but keeps the raw message so headers can be asserted. */
import { appendFileSync, writeFileSync } from 'node:fs';
import { SMTPServer } from 'smtp-server';

const PORT = Number(process.env.SMTP_PORT ?? 2526);
const LOG = process.env.SMTP_SINK_LOG ?? '/tmp/qa-u-sink.jsonl';
writeFileSync(LOG, '');
const server = new SMTPServer({
  authOptional: true,
  disabledCommands: ['STARTTLS'],
  onAuth(_a, _s, cb) { cb(null, { user: 'qa' }); },
  onData(stream, session, cb) {
    const chunks = [];
    stream.on('data', (c) => chunks.push(c));
    stream.on('end', () => {
      appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), rcptTo: session.envelope.rcptTo.map((r) => r.address), raw: Buffer.concat(chunks).toString('utf8') }) + '\n');
      cb();
    });
  },
});
server.listen(PORT, '127.0.0.1', () => console.log(`smtp sink (raw) on ${PORT}`));
