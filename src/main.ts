// whatspacd — daemon entry point.
//
// Wires the persistent agent to the RHP transport and the SQLite store from
// configuration, then starts it. The two heads (web, RF terminal) register onto
// the agent + store here in later slices.

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { WhatspacAgent } from "./agent/agent";
import { loadConfig } from "./config";
import { startRfHead } from "./heads/rf/index";
import { startWebHead } from "./heads/web/index";
import { RhpTcpTransport } from "./rhp/client";
import { Store } from "./store/store";
import { createLogger } from "./util/log";

async function main(): Promise<void> {
  const config = loadConfig();
  const log = createLogger(config.logLevel);

  mkdirSync(dirname(config.dbPath), { recursive: true });
  const store = new Store(config.dbPath);
  const transport = new RhpTcpTransport(config.rhp);
  const agent = new WhatspacAgent({ transport, store, config: config.agent, logger: log });

  agent.events.on("status", (s) => log.info(`status: ${s}`));
  agent.events.on("error", (e) => log.error("agent error", e.message));
  agent.events.on("connected", (r) => log.info("connected to WPS", r));

  const myCallsign = config.agent.whatsPacCallsign;

  // The two heads: a web UI and the RF terminal, both over the shared agent+store.
  const web = await startWebHead({
    agent,
    store,
    myCallsign,
    host: config.web.host,
    port: config.web.port,
    log,
  });
  log.info(`web head on http://${config.web.host}:${config.web.port}`);

  const rf = await startRfHead({
    agent,
    store,
    socketPath: config.rf.socketPath,
    myCallsign,
    log,
  });
  log.info(`RF terminal head on ${config.rf.socketPath}`);

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`received ${signal}, shutting down`);
    void Promise.allSettled([agent.stop(), web.close(), rf.close()]).then(() => {
      store.close();
      process.exit(0);
    });
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  log.info(
    `whatspacd: RHP ${config.rhp.host}:${config.rhp.port}, WhatsPac callsign ${myCallsign}`,
  );
  await agent.start();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
