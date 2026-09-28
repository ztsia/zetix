declare module 'hoodiecrow-imap' {
  import type { Server } from 'node:net';
  type ImapServer = {
    /** The underlying `net.Server`. */
    server: Server;
    listen(port: number, host: string, callback: () => void): void;
    close(callback?: () => void): void;
  };
  function hoodiecrow(options: Record<string, unknown>): ImapServer;
  export default hoodiecrow;
}
