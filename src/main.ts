// whatspacd — daemon entry point.
//
// Wires the persistent agent to the RHP transport and the SQLite store from
// configuration, then starts it. The two heads (web, RF terminal) register onto
// the agent + store here in later slices.

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { WhatspacAgent } from "./agent/agent";
import { loadConfig } from "./config";
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

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`received ${signal}, shutting down`);
    void agent.stop().finally(() => {
      store.close();
      process.exit(0);
    });
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  log.info(
    `whatspacd: RHP ${config.rhp.host}:${config.rhp.port}, WhatsPac callsign ${config.agent.whatsPacCallsign}`,
  );
  await agent.start();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
