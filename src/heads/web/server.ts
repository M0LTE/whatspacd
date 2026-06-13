// The HTTP server wrapper for the LAN/phone web head.
//
// Wraps buildWebApp with @hono/node-server's `serve`, bound to host:port. The
// daemon binds 127.0.0.1 only — that loopback boundary is what makes the
// app-gateway's injected X-Pdn-* identity headers trustworthy (a routable bind
// would let anyone forge them). Resolves once listening.

import { serve } from "@hono/node-server";
import type { Logger } from "../../agent/agent";
import { Store } from "../../store/store";
import { buildWebApp, type WebAgent } from "./app";

export interface StartWebHeadOptions {
  agent: WebAgent;
  store: Store;
  myCallsign: string;
  /** Bind address — MUST be 127.0.0.1 (loopback) per the app-gateway contract. */
  host: string;
  port: number;
  log?: Logger;
}

export interface WebHead {
  close(): Promise<void>;
}

const silentLog: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/**
 * Build the web app and serve it on `host:port`. Resolves once the listener is
 * up; the returned handle stops it.
 */
export async function startWebHead(opts: StartWebHeadOptions): Promise<WebHead> {
  const log = opts.log ?? silentLog;
  const app = buildWebApp({ agent: opts.agent, store: opts.store, myCallsign: opts.myCallsign });

  const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
    const s = serve({ fetch: app.fetch, hostname: opts.host, port: opts.port }, () => resolve(s));
  });

  log.info(`web head listening on http://${opts.host}:${opts.port}`);

  return {
    close(): Promise<void> {
      return new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
