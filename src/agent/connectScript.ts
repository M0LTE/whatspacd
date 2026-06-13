// The connect-script runner (docs/wps-protocol.md §6).
//
// WhatsPac never opens MB7NPW-9 directly: it opens the FIRST hop's `cmd` as the
// RHP remote, then replays a `[{cmd,val}]` dialogue — for each subsequent hop,
// send `cmd + "\r"` as a line and wait until the received text contains `val`,
// then advance. When the final hop's `val` is seen, the link is through to WPS
// and the WPS application protocol begins. Any bytes received after that final
// match are the start of the WPS stream and are returned as `leftover`.
//
// This phase is plain text (node-console prompts), not WPS frames — so it works
// on a latin1 view of the bytes (1 byte ↔ 1 char, offsets aligned).

export interface ConnectHop {
  id?: number;
  hop?: string;
  /** Text to transmit at this hop. The FIRST hop's cmd is the RHP open remote. */
  cmd: string;
  /** Substring to watch for in received text before advancing. */
  val: string;
}

export type ConnectScript = ConnectHop[];

export interface TimerFns {
  setTimeout(cb: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const systemTimerFns: TimerFns = {
  setTimeout: (cb, ms) => setTimeout(cb, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export function validateConnectScript(script: ConnectScript): void {
  if (script.length === 0) throw new Error("connect script is empty");
  for (const [i, hop] of script.entries()) {
    if (!hop.cmd) throw new Error(`connect script hop ${i} has no cmd`);
    if (!hop.val) throw new Error(`connect script hop ${i} has no val`);
  }
}

/**
 * Drives the connect-script dialogue over an already-open link. The owner opens
 * the link to `script[0].cmd`, constructs the runner, calls {@link start}, and
 * feeds inbound bytes via {@link feed}; the runner sends each subsequent hop's
 * command and resolves with the leftover bytes once the final `val` matches.
 */
export class ConnectScriptRunner {
  private hopIndex = 0;
  private text = "";
  private finished = false;
  private timer: unknown;

  constructor(
    private readonly script: ConnectScript,
    private readonly send: (data: Uint8Array) => void,
    private readonly onDone: (leftover: Uint8Array) => void,
    private readonly onError: (err: Error) => void,
    private readonly timeoutMs = 60_000,
    private readonly timers: TimerFns = systemTimerFns,
  ) {}

  /** Arm the connect timeout. The link is already open to `script[0]`'s remote. */
  start(): void {
    this.timer = this.timers.setTimeout(() => {
      if (this.finished) return;
      this.fail(
        new Error(
          `connect script timed out at hop ${this.hopIndex} waiting for ${JSON.stringify(
            this.script[this.hopIndex]?.val,
          )}`,
        ),
      );
    }, this.timeoutMs);
  }

  /** Feed received bytes; advances hops and sends the next command as each `val` matches. */
  feed(chunk: Uint8Array): void {
    if (this.finished) return;
    this.text += Buffer.from(chunk).toString("latin1");

    while (this.hopIndex < this.script.length) {
      const hop = this.script[this.hopIndex]!;
      const idx = this.text.indexOf(hop.val);
      if (idx === -1) return; // need more bytes for the current hop
      this.text = this.text.slice(idx + hop.val.length);
      this.hopIndex += 1;

      if (this.hopIndex >= this.script.length) {
        this.finish();
        return;
      }
      const next = this.script[this.hopIndex]!;
      this.send(Buffer.from(next.cmd + "\r", "latin1"));
    }
  }

  /** Abandon the run (e.g. the link dropped) without resolving. */
  cancel(): void {
    this.finished = true;
    this.timers.clearTimeout(this.timer);
  }

  private finish(): void {
    this.finished = true;
    this.timers.clearTimeout(this.timer);
    this.onDone(Buffer.from(this.text, "latin1"));
  }

  private fail(err: Error): void {
    this.finished = true;
    this.timers.clearTimeout(this.timer);
    this.onError(err);
  }
}
