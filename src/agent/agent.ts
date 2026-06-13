// The persistent WhatsPac agent.
//
// Owns the single connected-mode link to WPS: it opens the transport, runs the
// connect-script, sends the connect object (with delta cursors from the store),
// ingests the WPS stream into the store, keeps the link warm with the idle
// heartbeat, and reconnects + resyncs on drop. The two heads (web, RF) are pure
// renderers over this agent's store and event stream.

import {
  FrameReader,
  WpsDecodeError,
  encodeFrame,
  isType,
  type ChannelPost,
  type ConnectReply,
  type DirectMessage,
  type HamName,
  type UserObject,
  type WpsMessage,
} from "../protocol/index";
import type { AddressFamily, Callsign, RhpLink, RhpTransport } from "../rhp/transport";
import { Store } from "../store/store";
import { TypedEmitter } from "../util/emitter";
import {
  ConnectScriptRunner,
  validateConnectScript,
  type ConnectScript,
  type TimerFns,
} from "./connectScript";

export interface AgentConfig {
  family: AddressFamily;
  /** AX.25 source callsign; for NET-ROM (L4) this is "<callsign>@<nodeCall>". */
  localCallsign: Callsign;
  /** The user's WhatsPac callsign — the `c` field of the connect object and `fc` of outbound traffic. */
  whatsPacCallsign: Callsign;
  /** Display name — the `n` field of the connect object. */
  displayName: string;
  /** Client protocol version (0.92 in the analysed bundle). */
  clientVersion: number;
  /** The connect-script; `connectScript[0].cmd` is the RHP open remote. */
  connectScript: ConnectScript;
  /** RHP port label (engine interface selector). */
  rhpPort?: string | null;
  /** Idle heartbeat interval (default 9 min). */
  keepAliveIntervalMs?: number;
  /** Hard idle cap; the client self-disconnects past this (default 4 h). */
  idleCapMs?: number;
  /** Connect-script timeout (default 60 s). */
  connectTimeoutMs?: number;
  /** Reconnect backoff bounds. */
  reconnectInitialMs?: number;
  reconnectMaxMs?: number;
}

export type AgentStatus =
  | "idle"
  | "connecting"
  | "running"
  | "reconnecting"
  | "stopped";

export interface AgentEvents {
  status: (status: AgentStatus) => void;
  connected: (reply: ConnectReply) => void;
  message: (m: DirectMessage) => void;
  post: (p: ChannelPost) => void;
  presence: (online: Callsign[]) => void;
  /** Any WPS message we sent (inspection / tests). */
  sent: (msg: { t: string }) => void;
  error: (err: Error) => void;
}

export interface AgentTimers extends TimerFns {
  setInterval(cb: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export const systemTimers: AgentTimers = {
  setTimeout: (cb, ms) => setTimeout(cb, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  setInterval: (cb, ms) => setInterval(cb, ms),
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
};

export interface Logger {
  debug(msg: string, meta?: unknown): void;
  info(msg: string, meta?: unknown): void;
  warn(msg: string, meta?: unknown): void;
  error(msg: string, meta?: unknown): void;
}

const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

export interface AgentDeps {
  transport: RhpTransport;
  store: Store;
  config: AgentConfig;
  timers?: AgentTimers;
  logger?: Logger;
  /** Injectable clock for outbound message timestamps (tests). */
  now?: () => number;
}

const DEFAULTS = {
  keepAliveIntervalMs: 9 * 60_000,
  idleCapMs: 240 * 60_000,
  connectTimeoutMs: 60_000,
  reconnectInitialMs: 1_000,
  reconnectMaxMs: 60_000,
};

export class WhatspacAgent {
  readonly events = new TypedEmitter<AgentEvents>();

  private readonly transport: RhpTransport;
  private readonly store: Store;
  private readonly config: Required<
    Pick<
      AgentConfig,
      | "keepAliveIntervalMs"
      | "idleCapMs"
      | "connectTimeoutMs"
      | "reconnectInitialMs"
      | "reconnectMaxMs"
    >
  > &
    AgentConfig;
  private readonly timers: AgentTimers;
  private readonly log: Logger;
  private readonly now: () => number;

  private status: AgentStatus = "idle";
  private link?: RhpLink;
  private phase: "connect" | "wps" = "connect";
  private readonly reader = new FrameReader();
  private runner?: ConnectScriptRunner;

  private keepaliveHandle: unknown;
  private idleMs = 0;
  private reconnectAttempt = 0;
  private reconnectHandle: unknown;
  private stopping = false;

  constructor(deps: AgentDeps) {
    this.transport = deps.transport;
    this.store = deps.store;
    this.config = { ...DEFAULTS, ...deps.config };
    this.timers = deps.timers ?? systemTimers;
    this.log = deps.logger ?? silentLogger;
    this.now = deps.now ?? Date.now;
    validateConnectScript(this.config.connectScript);
  }

  getStatus(): AgentStatus {
    return this.status;
  }

  /** Connect and keep the link up; resolves once the WPS connect object is sent. */
  async start(): Promise<void> {
    this.stopping = false;
    await this.connect();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.timers.clearTimeout(this.reconnectHandle);
    this.runner?.cancel();
    this.stopKeepalive();
    const link = this.link;
    this.link = undefined;
    if (link) await link.close().catch(() => {});
    this.setStatus("stopped");
  }

  // ---- connection lifecycle ----

  // Resilient: never throws. A failure before the link is open schedules a
  // reconnect directly; a failure after open closes the link, whose onClose
  // handler then schedules the reconnect (so there is a single reconnect path).
  private async connect(): Promise<void> {
    this.setStatus("connecting");
    this.phase = "connect";
    this.reader.reset();

    const remote = this.config.connectScript[0]!.cmd;
    let link: RhpLink;
    try {
      link = await this.transport.open({
        family: this.config.family,
        local: this.config.localCallsign,
        remote,
        port: this.config.rhpPort ?? null,
      });
    } catch (err) {
      this.log.warn("RHP open failed", err instanceof Error ? err.message : String(err));
      if (!this.stopping) this.scheduleReconnect();
      return;
    }

    this.link = link;
    link.onClose((err) => this.onClose(err));

    try {
      const leftover = await new Promise<Uint8Array>((resolve, reject) => {
        this.runner = new ConnectScriptRunner(
          this.config.connectScript,
          (data) => void link.send(data).catch(reject),
          resolve,
          reject,
          this.config.connectTimeoutMs,
          this.timers,
        );
        link.onData((chunk) => this.onData(chunk));
        this.runner.start();
      });

      this.log.info("connect-script complete; entering WPS phase");
      this.phase = "wps";
      await this.sendConnectObject();
      if (leftover.length > 0) this.ingest(leftover);

      this.idleMs = 0;
      this.startKeepalive();
      this.reconnectAttempt = 0;
      this.setStatus("running");
    } catch (err) {
      this.log.warn("connect failed", err instanceof Error ? err.message : String(err));
      this.runner?.cancel();
      await link.close().catch(() => {}); // onClose -> scheduleReconnect
    }
  }

  private onData(chunk: Uint8Array): void {
    if (this.phase === "connect") {
      this.runner?.feed(chunk);
    } else {
      this.ingest(chunk);
    }
  }

  private ingest(chunk: Uint8Array): void {
    let messages: WpsMessage[];
    try {
      messages = this.reader.push(chunk);
    } catch (err) {
      // §4: a frame that fails to parse means CORRUPT_DATA — drop the link.
      if (err instanceof WpsDecodeError) {
        this.log.warn("corrupt WPS frame; dropping link", err.message);
        this.events.emit("error", err);
        void this.link?.close().catch(() => {});
        return;
      }
      throw err;
    }
    for (const msg of messages) this.dispatch(msg);
  }

  private onClose(err?: Error): void {
    this.runner?.cancel();
    this.stopKeepalive();
    this.link = undefined;
    if (this.stopping) return;
    if (err) this.log.warn("link closed with error", err.message);
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    this.setStatus("reconnecting");
    const delay = Math.min(
      this.config.reconnectInitialMs * 2 ** this.reconnectAttempt,
      this.config.reconnectMaxMs,
    );
    this.reconnectAttempt += 1;
    this.log.info(`reconnecting in ${delay}ms (attempt ${this.reconnectAttempt})`);
    this.reconnectHandle = this.timers.setTimeout(() => {
      this.connect().catch((err: unknown) => {
        this.log.warn("reconnect failed", err instanceof Error ? err.message : String(err));
        if (!this.stopping) this.scheduleReconnect();
      });
    }, delay);
  }

  // ---- keepalive (docs §7) ----

  private startKeepalive(): void {
    this.stopKeepalive();
    this.keepaliveHandle = this.timers.setInterval(
      () => this.onKeepaliveTick(),
      this.config.keepAliveIntervalMs,
    );
  }

  private stopKeepalive(): void {
    if (this.keepaliveHandle !== undefined) {
      this.timers.clearInterval(this.keepaliveHandle);
      this.keepaliveHandle = undefined;
    }
  }

  private onKeepaliveTick(): void {
    this.idleMs += this.config.keepAliveIntervalMs;
    if (this.idleMs >= this.config.idleCapMs) {
      this.log.info("idle cap reached; self-disconnecting (Application Timeout)");
      void this.link?.close().catch(() => {});
      return;
    }
    if (this.idleMs === this.config.keepAliveIntervalMs) {
      // First idle tick: a WhatsPic enquiry, not a bare keepalive.
      void this.sendWps({ t: "ae", lats: this.store.lastAvatarTs(), co: 1 }, false);
    } else {
      void this.sendWps({ t: "k" }, false);
    }
  }

  /** Reset the idle counter on genuine activity (user sends), restarting the heartbeat. */
  private resetIdle(): void {
    this.idleMs = 0;
    if (this.keepaliveHandle !== undefined) this.startKeepalive();
  }

  // ---- outbound ----

  private async sendWps<T extends { t: string }>(msg: T, resetIdle = true): Promise<void> {
    const link = this.link;
    if (!link) throw new Error("not connected");
    await link.send(encodeFrame(msg));
    if (resetIdle) this.resetIdle();
    this.events.emit("sent", msg);
  }

  private async sendConnectObject(): Promise<void> {
    const c = this.store.getConnectCursors();
    const connect: WpsMessage = {
      t: "c",
      n: this.config.displayName,
      c: this.config.whatsPacCallsign,
      lm: c.lm,
      le: c.le,
      led: c.led,
      lhts: c.lhts,
      v: this.config.clientVersion,
      ...(c.cc.length > 0 ? { cc: c.cc } : {}),
    };
    await this.sendWps(connect);
  }

  /** Send a direct message to `tc`. Stored optimistically, then transmitted. */
  async sendDirectMessage(tc: Callsign, text: string): Promise<void> {
    const ts = Math.floor(this.now() / 1000);
    const msg: DirectMessage = {
      t: "m",
      fc: this.config.whatsPacCallsign,
      tc,
      m: text,
      ts,
      _id: `${this.now()}-${this.config.whatsPacCallsign}`,
    };
    this.store.putDirectMessage(msg);
    await this.sendWps(msg);
  }

  /** Post `text` to channel `cid`. */
  async postToChannel(cid: string, text: string): Promise<void> {
    const ts = this.now();
    const post: ChannelPost = {
      t: "cp",
      cid,
      fc: this.config.whatsPacCallsign,
      p: text,
      ts,
      _id: `${ts}-${this.config.whatsPacCallsign}`,
    };
    this.store.putPost(post);
    await this.sendWps(post);
  }

  async subscribeChannel(cid: string): Promise<void> {
    const lcp = this.store.getConnectCursors().cc.find((c) => c.cid === cid)?.lp ?? 0;
    await this.sendWps({ t: "cs", s: 1, cid, lcp });
    this.store.setChannelSubscribed(cid, true);
  }

  async unsubscribeChannel(cid: string): Promise<void> {
    await this.sendWps({ t: "cs", s: 0, cid });
    this.store.setChannelSubscribed(cid, false);
  }

  // ---- inbound dispatch (docs §4) ----

  private dispatch(msg: WpsMessage): void {
    if (isType(msg, "c")) {
      if (typeof msg.w === "number") this.events.emit("connected", msg as ConnectReply);
      return;
    }
    if (isType(msg, "u")) {
      for (const u of msg.u as UserObject[]) this.store.upsertUser(u);
      return;
    }
    if (isType(msg, "o")) {
      this.store.setOnline(msg.o);
      this.events.emit("presence", this.store.onlineCallsigns());
      return;
    }
    if (isType(msg, "uc")) {
      this.store.addOnline(msg.c);
      this.events.emit("presence", this.store.onlineCallsigns());
      return;
    }
    if (isType(msg, "ud")) {
      this.store.removeOnline(msg.c);
      this.events.emit("presence", this.store.onlineCallsigns());
      return;
    }
    if (isType(msg, "he")) {
      for (const h of msg.h as HamName[]) {
        if (typeof h === "object" && h && "c" in h) this.store.upsertHam(h);
      }
      return;
    }
    if (isType(msg, "pch")) {
      for (const ch of msg.ch) this.store.upsertChannelHeader(ch);
      return;
    }
    if (isType(msg, "cs")) {
      if (typeof msg.s === "number") this.store.setChannelSubscribed(msg.cid, msg.s === 1);
      return;
    }
    if (isType(msg, "m")) {
      this.store.putDirectMessage(msg);
      this.events.emit("message", msg);
      return;
    }
    if (isType(msg, "mb")) {
      for (const m of msg.m) {
        this.store.putDirectMessage(m);
        this.events.emit("message", m);
      }
      return;
    }
    if (isType(msg, "cp")) {
      this.store.putPost(msg);
      this.events.emit("post", msg);
      return;
    }
    if (isType(msg, "cpb")) {
      for (const p of msg.p ?? []) {
        this.store.putPost(p);
        this.events.emit("post", p);
      }
      return;
    }
    if (isType(msg, "a")) {
      if (typeof msg.ac === "number") return; // pending-count notice
      this.store.upsertAvatar(msg);
      if (msg.c && this.store.hamUnknown(msg.c)) {
        void this.sendWps({ t: "he", h: [msg.c] }).catch(() => {});
      }
      return;
    }
    // Other types (edits, receipts, emoji, stats, enquiry replies, pairing,
    // avatar response) are accepted but not yet projected into the store.
    this.log.debug(`unhandled WPS type: ${msg.t}`);
  }

  private setStatus(status: AgentStatus): void {
    if (status === this.status) return;
    this.status = status;
    this.events.emit("status", status);
  }
}
