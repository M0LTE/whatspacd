// The concrete RHP-over-TCP transport: opens an outbound connected-mode AX.25
// (or NET-ROM) session through an RHPv2 host (pdn / XRouter / LinBPQ on
// TCP/9000) and exposes it as a duplex byte stream via the `RhpLink` seam.
//
// Wire details live in `wire.ts`; this file owns the socket, the
// request/reply correlation, and the push routing. Authoritative sources:
//   - Packet.Rhp2/{RhpFraming,RhpMessages,RhpJson,RhpConstants,RhpDataEncoding}.cs
//     (what pdn speaks)
//   - Packet.Rhp2.Server/RhpServer.cs (server-side behaviour: id echo, seqno
//     pushes, openReply carries the handle, server-initiated `close` push on
//     peer hangup)
//   - docs/platform-contracts.md §4 (the .NET client semantics this mirrors)
//   - whatspac-capture/index.pretty.js (SPA envelope shapes, over WebSocket)

import { createConnection, type Socket } from "node:net";

import type { RhpLink, RhpOpenOptions, RhpTransport } from "./transport";
import {
  bytesToWireString,
  decodeFrameBody,
  encodeFrame,
  ERR_OK,
  FrameDeframer,
  OPEN_FLAG_ACTIVE,
  type RhpEnvelope,
  type RhpReply,
  wireStringToBytes,
} from "./wire";

/** Construction options for {@link RhpTcpTransport}. */
export interface RhpTcpTransportOptions {
  /** RHP host to connect to. */
  host: string;
  /** RHP TCP port. Defaults to 9000 (the conventional pdn/XRouter port). */
  port?: number;
  /** Credentials, when the node requires auth. Omit to skip the `auth` step. */
  auth?: { user: string; pass: string };
  /**
   * How long to wait for a correlated reply (openReply / sendReply / authReply /
   * closeReply) before giving up. Defaults to 30s for open (a SABM can take air
   * time) and the same bound for the rest.
   */
  replyTimeoutMs?: number;
}

/** Family -> wire `pfam` value. */
const PFAM: Record<RhpOpenOptions["family"], string> = {
  ax25: "ax25",
  netrom: "netrom",
};

const DEFAULT_PORT = 9000;
const DEFAULT_REPLY_TIMEOUT_MS = 30_000;

/**
 * An `RhpTransport` over a TCP connection to an RHPv2 host. Each {@link open}
 * call dials a fresh connection, (optionally) authenticates, sends an Active
 * `open`, and returns a live {@link RhpLink} bound to the resulting handle.
 *
 * One connection per link keeps teardown trivial (closing the link closes the
 * socket) and matches the DAPPS outbound pattern (fresh client per connect).
 */
export class RhpTcpTransport implements RhpTransport {
  readonly #host: string;
  readonly #port: number;
  readonly #auth?: { user: string; pass: string };
  readonly #replyTimeoutMs: number;

  constructor(opts: RhpTcpTransportOptions) {
    this.#host = opts.host;
    this.#port = opts.port ?? DEFAULT_PORT;
    this.#auth = opts.auth;
    this.#replyTimeoutMs = opts.replyTimeoutMs ?? DEFAULT_REPLY_TIMEOUT_MS;
  }

  async open(opts: RhpOpenOptions): Promise<RhpLink> {
    const conn = await connectTcp(this.#host, this.#port);
    const session = new RhpConnection(conn, this.#replyTimeoutMs);
    try {
      if (this.#auth) {
        await session.authenticate(this.#auth.user, this.#auth.pass);
      }
      const handle = await session.open(opts);
      return new RhpTcpLink(session, handle);
    } catch (err) {
      // Open (or auth) failed — never leak the socket.
      session.destroy();
      throw err;
    }
  }
}

/** Dial a TCP connection, resolving once it is established. */
function connectTcp(host: string, port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host, port });
    const onError = (err: Error): void => {
      socket.removeListener("connect", onConnect);
      reject(err);
    };
    const onConnect = (): void => {
      socket.removeListener("error", onError);
      socket.setNoDelay(true);
      resolve(socket);
    };
    socket.once("error", onError);
    socket.once("connect", onConnect);
  });
}

interface PendingReply {
  resolve: (reply: RhpReply) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * Owns one RHP TCP socket: id-correlated request/reply, push routing to
 * per-handle listeners, and teardown. A connection may carry one link in this
 * transport (one open per connection), but the multiplexing machinery is here
 * because the protocol itself multiplexes by handle.
 */
class RhpConnection {
  readonly #socket: Socket;
  readonly #deframer = new FrameDeframer();
  readonly #replyTimeoutMs: number;

  #nextId = 1;
  readonly #pending = new Map<number, PendingReply>();

  // Per-handle inbound + close listeners (the RhpLink subscribes here).
  readonly #dataListeners = new Map<number, (chunk: Uint8Array) => void>();
  readonly #closeListeners = new Map<number, (err?: Error) => void>();

  #closed = false;
  #fatalError: Error | undefined;

  constructor(socket: Socket, replyTimeoutMs: number) {
    this.#socket = socket;
    this.#replyTimeoutMs = replyTimeoutMs;

    socket.on("data", (chunk: Buffer) => this.#onData(chunk));
    socket.on("error", (err: Error) => this.#onTransportEnd(err));
    socket.on("close", () => this.#onTransportEnd(this.#fatalError));
    // A FIN from the peer with no further frames is a clean transport end.
    socket.on("end", () => this.#onTransportEnd(this.#fatalError));
  }

  // --- inbound frames -----------------------------------------------------

  #onData(chunk: Buffer): void {
    let bodies: Uint8Array[];
    try {
      bodies = this.#deframer.push(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
    } catch (err) {
      this.#fail(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    for (const body of bodies) {
      if (body.length === 0) continue; // legal zero-length keepalive/noise frame
      let env: RhpEnvelope;
      try {
        env = decodeFrameBody(body);
      } catch {
        // A single malformed frame after valid framing: skip it rather than
        // tear the whole connection down. (The server only ever emits valid
        // JSON; this guards against a desync we can still recover from.)
        continue;
      }
      this.#dispatch(env);
    }
  }

  #dispatch(env: RhpEnvelope): void {
    // Replies correlate by `id`. Pushes (recv/status/close/accept) carry a
    // `seqno` and no `id`, and are routed by `handle`.
    if (typeof env["id"] === "number") {
      const pending = this.#pending.get(env["id"]);
      if (pending) {
        this.#pending.delete(env["id"]);
        clearTimeout(pending.timer);
        pending.resolve(env as RhpReply);
        return;
      }
      // An id we don't recognise (or a late reply after timeout) — ignore.
      return;
    }

    switch (env.type) {
      case "recv":
        this.#onRecv(env);
        return;
      case "close":
        // Server-initiated close push: the peer hung up / the link dropped.
        this.#onServerClose(env);
        return;
      // `status` and `accept` pushes are not actioned by an outbound stream
      // client (status is advisory; accept only matters to listeners). Drop.
      default:
        return;
    }
  }

  #onRecv(env: RhpEnvelope): void {
    const handle = env["handle"];
    if (typeof handle !== "number") return;
    const listener = this.#dataListeners.get(handle);
    if (!listener) return;
    const data = env["data"];
    const bytes = typeof data === "string" ? wireStringToBytes(data) : new Uint8Array(0);
    listener(bytes);
  }

  #onServerClose(env: RhpEnvelope): void {
    const handle = env["handle"];
    if (typeof handle !== "number") return;
    const listener = this.#closeListeners.get(handle);
    this.#dataListeners.delete(handle);
    this.#closeListeners.delete(handle);
    if (listener) listener(undefined); // remote close — no error
  }

  // --- transport teardown -------------------------------------------------

  #onTransportEnd(err?: Error): void {
    if (this.#closed) return;
    this.#closed = true;

    const finalErr = err ?? this.#fatalError;

    // Fail any in-flight requests.
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(finalErr ?? new Error("RHP connection closed before reply."));
    }
    this.#pending.clear();

    // Notify every live handle's close listener (transport drop).
    const closeListeners = [...this.#closeListeners.values()];
    this.#dataListeners.clear();
    this.#closeListeners.clear();
    for (const listener of closeListeners) listener(finalErr);
  }

  #fail(err: Error): void {
    this.#fatalError = err;
    try {
      this.#socket.destroy(err);
    } catch {
      // already gone
    }
    this.#onTransportEnd(err);
  }

  // --- requests -----------------------------------------------------------

  /** Send a request that expects a correlated reply; resolve with that reply. */
  #request(envelope: RhpEnvelope & { type: string }): Promise<RhpReply> {
    if (this.#closed) {
      return Promise.reject(this.#fatalError ?? new Error("RHP connection is closed."));
    }
    const id = this.#nextId++;
    return new Promise<RhpReply>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`RHP request '${String(envelope.type)}' (id ${id}) timed out.`));
      }, this.#replyTimeoutMs);
      if (typeof timer.unref === "function") timer.unref();
      this.#pending.set(id, { resolve, reject, timer });
      try {
        this.#write({ ...envelope, id });
      } catch (err) {
        this.#pending.delete(id);
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /** Send a frame with no reply correlation (fire-and-forget). */
  #write(envelope: RhpEnvelope): void {
    const frame = encodeFrame(envelope);
    this.#socket.write(frame);
  }

  async authenticate(user: string, pass: string): Promise<void> {
    const reply = await this.#request({ type: "auth", user, pass });
    throwOnErr(reply, "auth");
  }

  /** Send the Active `open`, await `openReply`, return the integer handle. */
  async open(opts: RhpOpenOptions): Promise<number> {
    const reply = await this.#request({
      type: "open",
      pfam: PFAM[opts.family],
      mode: "stream",
      flags: OPEN_FLAG_ACTIVE,
      // `port: null` lets the host choose its bearer; omit `local` if not given.
      port: opts.port ?? null,
      ...(opts.local !== undefined ? { local: opts.local } : {}),
      remote: opts.remote,
    });
    throwOnErr(reply, "open");
    const handle = reply["handle"];
    if (typeof handle !== "number") {
      throw new Error("RHP openReply carried no integer handle.");
    }
    return handle;
  }

  /** Send `data` bytes on a handle; reject on errCode != 0. */
  async send(handle: number, data: Uint8Array): Promise<void> {
    const reply = await this.#request({
      type: "send",
      handle,
      data: bytesToWireString(data),
    });
    throwOnErr(reply, "send");
  }

  /**
   * Send a best-effort `close` for a handle. Fire-and-forget: we do NOT block
   * on the `closeReply`, because we tear the socket down immediately after (one
   * connection per link) — waiting on a reply we're about to make moot would
   * just stall teardown for the reply timeout. Never throws.
   */
  closeHandle(handle: number): void {
    if (this.#closed) return;
    try {
      // No `id` -> the server sends no success reply for it (and we want none).
      this.#write({ type: "close", handle });
    } catch {
      // best-effort: the link is going away regardless
    }
  }

  onData(handle: number, listener: (chunk: Uint8Array) => void): void {
    this.#dataListeners.set(handle, listener);
  }

  onClose(handle: number, listener: (err?: Error) => void): void {
    this.#closeListeners.set(handle, listener);
    // If the transport already died before the link subscribed, fire now so
    // the caller still learns the session is gone.
    if (this.#closed) {
      this.#closeListeners.delete(handle);
      listener(this.#fatalError);
    }
  }

  /** Tear the socket down immediately (used on open failure). */
  destroy(): void {
    try {
      this.#socket.destroy();
    } catch {
      // already gone
    }
    this.#onTransportEnd(this.#fatalError);
  }

  /** Half-close gracefully, then ensure the socket is gone. */
  end(): void {
    try {
      this.#socket.end();
    } catch {
      // already gone
    }
  }

  get closed(): boolean {
    return this.#closed;
  }
}

/** Throw a descriptive error if a reply carries a non-zero `errCode`. */
function throwOnErr(reply: RhpReply, what: string): void {
  const code = reply["errCode"];
  if (typeof code === "number" && code !== ERR_OK) {
    const text = typeof reply["errText"] === "string" ? reply["errText"] : "";
    throw new Error(`RHP ${what} failed: errCode ${code}${text ? ` (${text})` : ""}`);
  }
}

/** The duplex byte channel handed back from {@link RhpTcpTransport.open}. */
class RhpTcpLink implements RhpLink {
  readonly #conn: RhpConnection;
  readonly #handle: number;
  #localClosed = false;

  constructor(conn: RhpConnection, handle: number) {
    this.#conn = conn;
    this.#handle = handle;
  }

  async send(data: Uint8Array): Promise<void> {
    await this.#conn.send(this.#handle, data);
  }

  async close(): Promise<void> {
    if (this.#localClosed) return; // idempotent
    this.#localClosed = true;
    // Best-effort close on the wire, then tear the socket down. One connection
    // per link: ending the socket is the cleanest close, and the server frees
    // the handle when the RHP TCP connection drops (PWP-0222) regardless.
    this.#conn.closeHandle(this.#handle);
    this.#conn.end();
  }

  onData(listener: (chunk: Uint8Array) => void): void {
    this.#conn.onData(this.#handle, listener);
  }

  onClose(listener: (err?: Error) => void): void {
    this.#conn.onClose(this.#handle, listener);
  }
}
