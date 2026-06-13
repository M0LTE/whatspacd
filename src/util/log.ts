// A minimal leveled logger writing to stderr (stdout is reserved for any future
// pdn-app/1 stdio session use). Structurally satisfies the agent's Logger.

import type { Logger } from "../agent/agent";

export type LogLevel = "debug" | "info" | "warn" | "error";

const ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export function createLogger(minLevel: LogLevel = "info"): Logger {
  const min = ORDER[minLevel];
  const emit = (level: LogLevel, msg: string, meta?: unknown): void => {
    if (ORDER[level] < min) return;
    const line = `${level.toUpperCase().padEnd(5)} ${msg}`;
    if (meta === undefined) process.stderr.write(line + "\n");
    else process.stderr.write(`${line} ${JSON.stringify(meta)}\n`);
  };
  return {
    debug: (m, meta) => emit("debug", m, meta),
    info: (m, meta) => emit("info", m, meta),
    warn: (m, meta) => emit("warn", m, meta),
    error: (m, meta) => emit("error", m, meta),
  };
}
