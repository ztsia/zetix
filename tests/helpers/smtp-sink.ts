import { SMTPServer } from 'smtp-server';
import type { AddressInfo } from 'node:net';

/**
 * A real SMTP server on `127.0.0.1`, for the tests that must exercise the
 * protocol rather than the message composer.
 *
 * `local.md` §7 measured the boundary: `smtp.gmail.com` is blocked on 587 and
 * 465 from any container, and the app password is deliberately absent, so no
 * cloud session can send real mail. What a sink cannot prove is deliverability
 * — SPF, DKIM, spam placement — and that is queued as a local task (§3).
 * Everything else is provable here, because idempotency is a database property
 * and message shape is a composer property; neither needs Gmail.
 *
 * This exists alongside `createStreamTransport()` because the two prove
 * different things. `streamTransport` proves what the bytes are. Only a server
 * that speaks the protocol can prove `AUTH`, `MAIL FROM`, `RCPT TO`, and — the
 * one that matters for the dispatcher — what happens when the far end says
 * `550`.
 */
export type SinkMessage = {
  mailFrom: string;
  rcptTo: string[];
  raw: Buffer;
};

export type Sink = {
  port: number;
  messages: SinkMessage[];
  /** How many TCP connections were opened. Proves pooling. */
  connections: number;
  auth: { username: string; password: string } | null;
  close(): Promise<void>;
};

export type SinkOptions = {
  /** Reject every recipient with this code, to drive the failure path. */
  rejectWith?: { code: number; message: string };
};

export async function startSmtpSink(options: SinkOptions = {}): Promise<Sink> {
  const messages: SinkMessage[] = [];
  const state = { connections: 0, auth: null as Sink['auth'] };

  const server = new SMTPServer({
    authOptional: true,
    // The sink speaks plaintext; TLS is the one thing it does not model, and
    // `secure` is a transport-config difference rather than a code path.
    disabledCommands: ['STARTTLS'],
    onConnect(_session, callback) {
      state.connections += 1;
      callback();
    },
    onAuth(auth, _session, callback) {
      state.auth = { username: auth.username ?? '', password: auth.password ?? '' };
      callback(null, { user: auth.username });
    },
    onRcptTo(address, _session, callback) {
      if (options.rejectWith) {
        const error = new Error(options.rejectWith.message) as Error & { responseCode?: number };
        error.responseCode = options.rejectWith.code;
        callback(error);
        return;
      }
      callback();
    },
    onData(stream, session, callback) {
      const chunks: Buffer[] = [];
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('end', () => {
        messages.push({
          mailFrom: session.envelope.mailFrom ? session.envelope.mailFrom.address : '',
          rcptTo: session.envelope.rcptTo.map((r) => r.address),
          raw: Buffer.concat(chunks),
        });
        callback(null, '250 Message accepted');
      });
    },
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.server.address() as AddressInfo).port;

  return {
    port,
    messages,
    get connections() {
      return state.connections;
    },
    get auth() {
      return state.auth;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
