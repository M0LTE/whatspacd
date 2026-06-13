// Configuration, loaded from the environment.
//
// whatspacd runs standalone (its own env) or under a pdn host (which injects
// PDN_RHP_HOST/PORT, PDN_NODE_CALLSIGN, PDN_APP_STATE). pdn vars are accepted as
// fallbacks so the same binary works in both worlds with no app-specific glue.

import { join } from "node:path";
import type { AgentConfig } from "./agent/agent";
import { validateConnectScript, type ConnectScript } from "./agent/connectScript";
import type { LogLevel } from "./util/log";

export interface Config {
  rhp: { host: string; port: number; auth?: { user: string; pass: string } };
  agent: AgentConfig;
  dbPath: string;
  logLevel: LogLevel;
  /** Loopback bind address + port for the web head (Slice 4). */
  web: { host: string; port: number };
}

const CLIENT_VERSION = 0.92;

function env(name: string, ...fallbacks: string[]): string | undefined {
  for (const key of [name, ...fallbacks]) {
    const v = process.env[key];
    if (v !== undefined && v !== "") return v;
  }
  return undefined;
}

function required(name: string, ...fallbacks: string[]): string {
  const v = env(name, ...fallbacks);
  if (v === undefined) {
    throw new Error(
      `missing required configuration: set ${[name, ...fallbacks].join(" or ")}`,
    );
  }
  return v;
}

function num(name: string, fallback: number): number {
  const v = env(name);
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number (got ${JSON.stringify(v)})`);
  return n;
}

/** Build the connect-script from an explicit JSON override, or from node/WPS parts. */
function loadConnectScript(): ConnectScript {
  const raw = env("WHATSPACD_CONNECT_SCRIPT");
  if (raw !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (cause) {
      throw new Error("WHATSPACD_CONNECT_SCRIPT is not valid JSON", { cause });
    }
    if (!Array.isArray(parsed)) throw new Error("WHATSPACD_CONNECT_SCRIPT must be a JSON array");
    const script = parsed as ConnectScript;
    validateConnectScript(script);
    return script;
  }

  const nodeCall = env("WHATSPACD_NODE_CALL") ?? "GB7NBH";
  const nodeBanner = env("WHATSPACD_NODE_BANNER") ?? nodeCall;
  const wpsCall = env("WHATSPACD_WPS_CALL") ?? "MB7NPW-9";
  const script: ConnectScript = [
    { hop: nodeCall, cmd: nodeCall, val: nodeBanner },
    { hop: "WPS", cmd: `C ${wpsCall}`, val: "*** Connected" },
  ];
  validateConnectScript(script);
  return script;
}

export function loadConfig(): Config {
  const whatsPacCallsign = required("WHATSPACD_CALLSIGN");
  const localCallsign = env("WHATSPACD_LOCAL_CALLSIGN", "PDN_NODE_CALLSIGN") ?? whatsPacCallsign;
  const family = (env("WHATSPACD_FAMILY") ?? "ax25") as AgentConfig["family"];
  if (family !== "ax25" && family !== "netrom") {
    throw new Error(`WHATSPACD_FAMILY must be "ax25" or "netrom" (got ${JSON.stringify(family)})`);
  }

  const stateDir = env("WHATSPACD_STATE_DIR", "PDN_APP_STATE") ?? "./state";
  const rhpUser = env("WHATSPACD_RHP_USER");
  const rhpPass = env("WHATSPACD_RHP_PASS");

  return {
    rhp: {
      host: env("WHATSPACD_RHP_HOST", "PDN_RHP_HOST") ?? "127.0.0.1",
      port: num("WHATSPACD_RHP_PORT", env("PDN_RHP_PORT") ? Number(env("PDN_RHP_PORT")) : 9000),
      ...(rhpUser !== undefined ? { auth: { user: rhpUser, pass: rhpPass ?? "" } } : {}),
    },
    agent: {
      family,
      localCallsign,
      whatsPacCallsign,
      displayName: env("WHATSPACD_NAME") ?? whatsPacCallsign,
      clientVersion: CLIENT_VERSION,
      connectScript: loadConnectScript(),
      rhpPort: env("WHATSPACD_BEARER_PORT") ?? null,
    },
    dbPath: join(stateDir, "whatspac.db"),
    logLevel: (env("WHATSPACD_LOG_LEVEL") ?? "info") as LogLevel,
    web: {
      host: env("WHATSPACD_WEB_HOST") ?? "127.0.0.1",
      port: num("WHATSPACD_WEB_PORT", 18900),
    },
  };
}
