// In-memory test harness: a mock RHP transport + a scripted mock WPS server.
//
// The MockLink is a duplex byte channel. Bytes the agent sends arrive at the
// MockWps; bytes the MockWps "delivers" arrive at the agent's onData listener.
// Deliveries before the agent attaches a listener are buffered then flushed —
// mirroring what a real RHP client must do, and letting the mock send the first
// connect-script banner during open().

import { FrameReader, encodeFrame, type WpsMessage } from "../../src/protocol/index";
import type { AgentTimers } from "../../src/agent/agent";
import type { ConnectScript } from "../../src/agent/connectScript";
import type { RhpLink, RhpOpenOptions, RhpTransport } from "../../src/rhp/transport";

export class MockLink implements RhpLink {
  private dataListeners: ((c: Uint8Array) => void)[] = [];
  private closeListeners: ((e?: Error) => void)[] = [];
  private pending: Uint8Array[] = [];
  closed = false;

  constructor(private readonly onAgentSend: (data: Uint8Array) => void) {}

  send(data: Uint8Array): Promise<void> {
    if (this.closed) return Promise.reject(new Error("link closed"));
    this.onAgentSend(data);
    return Promise.resolve();
  }

  close(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      for (const l of [...this.closeListeners]) l();
    }
    return Promise.resolve();
  }

  onData(listener: (chunk: Uint8Array) => void): void {
    this.dataListeners.push(listener);
    if (this.pending.length > 0) {
      const flush = this.pending;
      this.pending = [];
      for (const chunk of flush) listener(chunk);
    }
  }

  onClose(listener: (err?: Error) => void): void {
    this.closeListeners.push(listener);
  }

  /** Server -> agent. */
  deliver(data: Uint8Array): void {
    if (this.dataListeners.length === 0) {
      this.pending.push(data);
      return;
    }
    for (const l of [...this.dataListeners]) l(data);
  }

  /** Simulate a remote/transport drop. */
  drop(err?: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const l of [...this.closeListeners]) l(err);
  }
}

export interface MockWpsApi {
  send(msg: WpsMessage): void;
  sendText(text: string): void;
}

export interface MockWpsOptions {
  /** Called with each connect object the agent sends (once per connect). */
  onConnect?: (connect: WpsMessage, api: MockWpsApi) => void;
  /** Called for every other WPS message the agent sends. */
  onMessage?: (msg: WpsMessage, api: MockWpsApi) => void;
}

export class MockWps {
  link!: MockLink;
  readonly connectObjects: WpsMessage[] = [];
  readonly received: WpsMessage[] = [];
  private phase: "connect" | "wps" = "connect";
  private textBuf = "";
  private sentHop = -1;
  private reader = new FrameReader();

  constructor(
    private readonly script: ConnectScript,
    private readonly opts: MockWpsOptions = {},
  ) {}

  private api: MockWpsApi = {
    send: (msg) => this.link.deliver(encodeFrame(msg)),
    sendText: (text) => this.link.deliver(Buffer.from(text, "latin1")),
  };

  /** Begin a fresh connection: reset phase and send the first hop's banner. */
  begin(link: MockLink): void {
    this.link = link;
    this.phase = "connect";
    this.textBuf = "";
    this.sentHop = -1;
    this.reader.reset();
    this.advanceConnect();
  }

  /** Bytes from the agent. */
  receive(data: Uint8Array): void {
    if (this.phase === "connect") {
      this.textBuf += Buffer.from(data).toString("latin1");
      this.advanceConnect();
      return;
    }
    for (const msg of this.reader.push(data)) {
      this.received.push(msg);
      if (msg.t === "c") {
        this.connectObjects.push(msg);
        this.opts.onConnect?.(msg, this.api);
      } else {
        this.opts.onMessage?.(msg, this.api);
      }
    }
  }

  // Send each hop's `val` once its `cmd` has been seen (the first hop's banner
  // is sent immediately on open, before any cmd).
  private advanceConnect(): void {
    while (this.sentHop + 1 < this.script.length) {
      const next = this.sentHop + 1;
      const hop = this.script[next]!;
      if (next === 0 || this.textBuf.includes(hop.cmd)) {
        this.api.sendText(hop.val);
        this.sentHop = next;
        if (next > 0) {
          const at = this.textBuf.indexOf(hop.cmd);
          this.textBuf = this.textBuf.slice(at + hop.cmd.length);
        }
      } else {
        return;
      }
    }
    if (this.sentHop >= this.script.length - 1) this.phase = "wps";
  }
}

export class MockTransport implements RhpTransport {
  lastOptions?: RhpOpenOptions;
  link?: MockLink;

  constructor(private readonly wps: MockWps) {}

  open(opts: RhpOpenOptions): Promise<RhpLink> {
    this.lastOptions = opts;
    const link = new MockLink((data) => this.wps.receive(data));
    this.link = link;
    this.wps.begin(link);
    return Promise.resolve(link);
  }
}

/** A controllable AgentTimers for deterministic keepalive/reconnect tests. */
export class FakeTimers implements AgentTimers {
  private nextId = 1;
  private timeouts = new Map<number, () => void>();
  private intervals = new Map<number, () => void>();

  setTimeout(cb: () => void): unknown {
    const id = this.nextId++;
    this.timeouts.set(id, cb);
    return id;
  }
  clearTimeout(handle: unknown): void {
    this.timeouts.delete(handle as number);
  }
  setInterval(cb: () => void): unknown {
    const id = this.nextId++;
    this.intervals.set(id, cb);
    return id;
  }
  clearInterval(handle: unknown): void {
    this.intervals.delete(handle as number);
  }

  /** Fire every currently-registered one-shot timeout (clearing them first). */
  runTimeouts(): void {
    const cbs = [...this.timeouts.values()];
    this.timeouts.clear();
    for (const cb of cbs) cb();
  }

  /** Fire each currently-registered interval once. */
  tickIntervals(): void {
    for (const cb of [...this.intervals.values()]) cb();
  }

  get intervalCount(): number {
    return this.intervals.size;
  }
}
