import { type AddressInfo, createServer, type Server, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { RhpTcpTransport } from "../../src/rhp/client";
import {
  bytesToWireString,
  decodeFrameBody,
  encodeFrame,
  FrameDeframer,
  OPEN_FLAG_ACTIVE,
  type RhpEnvelope,
  wireStringToBytes,
} from "../../src/rhp/wire";

/**
 * A minimal fake RHPv2 TCP server for driving the client end-to-end. It frames
 * with the real 2-byte big-endian length prefix and lets a per-connection
 * handler script the conversation.
 */
class FakeRhpServer {
  readonly #server: Server;
  #handler: (socket: Socket, request: RhpEnvelope) => void = () => {};
  readonly sockets = new Set<Socket>();

  private constructor(server: Server) {
    this.#server = server;
  }

  static async start(): Promise<FakeRhpServer> {
    const server = createServer();
    const fake = new FakeRhpServer(server);
    server.on("connection", (socket) => {
      fake.sockets.add(socket);
      const deframer = new FrameDeframer();
      socket.on("data", (chunk) => {
        for (const body of deframer.push(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength))) {
          if (body.length === 0) continue;
          fake.#handler(socket, decodeFrameBody(body));
        }
      });
      socket.on("error", () => {});
      socket.on("close", () => fake.sockets.delete(socket));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return fake;
  }

  get port(): number {
    return (this.#server.address() as AddressInfo).port;
  }

  /** Install the per-request handler (the conversation script). */
  onRequest(handler: (socket: Socket, request: RhpEnvelope) => void): void {
    this.#handler = handler;
  }

  /** Push an arbitrary envelope to a connected client socket. */
  static send(socket: Socket, env: RhpEnvelope): void {
    socket.write(encodeFrame(env));
  }

  async stop(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }
}

let server: FakeRhpServer | undefined;

afterEach(async () => {
  if (server) {
    await server.stop();
    server = undefined;
  }
});

describe("RhpTcpTransport end-to-end", () => {
  it("opens an Active ax25 stream and captures the handle", async () => {
    server = await FakeRhpServer.start();
    let openReq: RhpEnvelope | undefined;
    server.onRequest((socket, req) => {
      if (req.type === "open") {
        openReq = req;
        FakeRhpServer.send(socket, { type: "openReply", id: req.id, handle: 100, errCode: 0, errText: "Ok" });
      }
    });

    const transport = new RhpTcpTransport({ host: "127.0.0.1", port: server.port });
    const link = await transport.open({ family: "ax25", local: "M0LTE-7", remote: "MB7NPW-9", port: null });
    expect(link).toBeDefined();

    expect(openReq).toBeDefined();
    expect(openReq!.type).toBe("open");
    expect(openReq!["pfam"]).toBe("ax25");
    expect(openReq!["mode"]).toBe("stream");
    expect(openReq!["flags"]).toBe(OPEN_FLAG_ACTIVE);
    expect(openReq!["local"]).toBe("M0LTE-7");
    expect(openReq!["remote"]).toBe("MB7NPW-9");
    expect(openReq!["port"]).toBeNull();
    expect(typeof openReq!.id).toBe("number");

    await link.close();
  });

  it("maps netrom family to pfam=netrom", async () => {
    server = await FakeRhpServer.start();
    let openReq: RhpEnvelope | undefined;
    server.onRequest((socket, req) => {
      if (req.type === "open") {
        openReq = req;
        FakeRhpServer.send(socket, { type: "openReply", id: req.id, handle: 101, errCode: 0 });
      }
    });
    const transport = new RhpTcpTransport({ host: "127.0.0.1", port: server.port });
    const link = await transport.open({ family: "netrom", local: "M0LTE@GB7RDG", remote: "NODE", port: null });
    expect(openReq!["pfam"]).toBe("netrom");
    await link.close();
  });

  it("authenticates before open when credentials are configured", async () => {
    server = await FakeRhpServer.start();
    const seen: string[] = [];
    server.onRequest((socket, req) => {
      seen.push(req.type);
      if (req.type === "auth") {
        expect(req["user"]).toBe("svc");
        expect(req["pass"]).toBe("secret");
        FakeRhpServer.send(socket, { type: "authReply", id: req.id, errCode: 0, errText: "Ok" });
      } else if (req.type === "open") {
        FakeRhpServer.send(socket, { type: "openReply", id: req.id, handle: 100, errCode: 0 });
      }
    });
    const transport = new RhpTcpTransport({
      host: "127.0.0.1",
      port: server.port,
      auth: { user: "svc", pass: "secret" },
    });
    const link = await transport.open({ family: "ax25", local: "M0LTE-7", remote: "MB7NPW-9" });
    expect(seen).toEqual(["auth", "open"]);
    await link.close();
  });

  it("rejects open when authentication fails", async () => {
    server = await FakeRhpServer.start();
    server.onRequest((socket, req) => {
      if (req.type === "auth") {
        FakeRhpServer.send(socket, { type: "authReply", id: req.id, errCode: 14, errText: "Unauthorised" });
      }
    });
    const transport = new RhpTcpTransport({
      host: "127.0.0.1",
      port: server.port,
      auth: { user: "svc", pass: "wrong" },
    });
    await expect(
      transport.open({ family: "ax25", local: "M0LTE-7", remote: "MB7NPW-9" }),
    ).rejects.toThrow(/errCode 14/);
  });

  it("rejects open on a non-zero openReply errCode", async () => {
    server = await FakeRhpServer.start();
    server.onRequest((socket, req) => {
      if (req.type === "open") {
        FakeRhpServer.send(socket, { type: "openReply", id: req.id, handle: 0, errCode: 7, errText: "Invalid remote address" });
      }
    });
    const transport = new RhpTcpTransport({ host: "127.0.0.1", port: server.port });
    await expect(
      transport.open({ family: "ax25", local: "M0LTE-7", remote: "BAD" }),
    ).rejects.toThrow(/errCode 7/);
  });

  it("sends bytes as a Latin-1 data string on the handle and resolves on errCode 0", async () => {
    server = await FakeRhpServer.start();
    let sendReq: RhpEnvelope | undefined;
    server.onRequest((socket, req) => {
      if (req.type === "open") {
        FakeRhpServer.send(socket, { type: "openReply", id: req.id, handle: 100, errCode: 0 });
      } else if (req.type === "send") {
        sendReq = req;
        FakeRhpServer.send(socket, { type: "sendReply", id: req.id, handle: req["handle"], errCode: 0, status: 2 });
      }
    });
    const transport = new RhpTcpTransport({ host: "127.0.0.1", port: server.port });
    const link = await transport.open({ family: "ax25", local: "M0LTE-7", remote: "MB7NPW-9" });

    const payload = new Uint8Array([0x00, 0xc3, 0xff, 0x48, 0x69, 0x0d]);
    await link.send(payload);

    expect(sendReq).toBeDefined();
    expect(sendReq!["handle"]).toBe(100);
    expect([...wireStringToBytes(sendReq!["data"] as string)]).toEqual([...payload]);

    await link.close();
  });

  it("rejects send on a non-zero sendReply errCode", async () => {
    server = await FakeRhpServer.start();
    server.onRequest((socket, req) => {
      if (req.type === "open") {
        FakeRhpServer.send(socket, { type: "openReply", id: req.id, handle: 100, errCode: 0 });
      } else if (req.type === "send") {
        FakeRhpServer.send(socket, { type: "sendReply", id: req.id, handle: req["handle"], errCode: 17, errText: "Not connected" });
      }
    });
    const transport = new RhpTcpTransport({ host: "127.0.0.1", port: server.port });
    const link = await transport.open({ family: "ax25", local: "M0LTE-7", remote: "MB7NPW-9" });
    await expect(link.send(new Uint8Array([1, 2, 3]))).rejects.toThrow(/errCode 17/);
    await link.close();
  });

  it("delivers recv pushes for this handle as decoded bytes, filtering other handles", async () => {
    server = await FakeRhpServer.start();
    let clientSocket: Socket | undefined;
    server.onRequest((socket, req) => {
      if (req.type === "open") {
        clientSocket = socket;
        FakeRhpServer.send(socket, { type: "openReply", id: req.id, handle: 100, errCode: 0 });
      }
    });
    const transport = new RhpTcpTransport({ host: "127.0.0.1", port: server.port });
    const link = await transport.open({ family: "ax25", local: "M0LTE-7", remote: "MB7NPW-9" });

    const received: number[][] = [];
    link.onData((chunk) => received.push([...chunk]));

    const wanted = new Uint8Array([0x00, 0xc3, 0xff, 0x42]);
    // A push for a DIFFERENT handle must be ignored.
    FakeRhpServer.send(clientSocket!, { type: "recv", handle: 999, data: bytesToWireString(new Uint8Array([1, 2])), seqno: 0 });
    FakeRhpServer.send(clientSocket!, { type: "recv", handle: 100, data: bytesToWireString(wanted), seqno: 1 });

    await waitFor(() => received.length === 1);
    expect(received[0]).toEqual([...wanted]);

    await link.close();
  });

  it("delivers multiple recv pushes coalesced into one TCP segment, in order", async () => {
    server = await FakeRhpServer.start();
    let clientSocket: Socket | undefined;
    server.onRequest((socket, req) => {
      if (req.type === "open") {
        clientSocket = socket;
        FakeRhpServer.send(socket, { type: "openReply", id: req.id, handle: 100, errCode: 0 });
      }
    });
    const transport = new RhpTcpTransport({ host: "127.0.0.1", port: server.port });
    const link = await transport.open({ family: "ax25", local: "M0LTE-7", remote: "MB7NPW-9" });
    const received: string[] = [];
    link.onData((chunk) => received.push(String.fromCharCode(...chunk)));

    const a = encodeFrame({ type: "recv", handle: 100, data: "one", seqno: 0 });
    const b = encodeFrame({ type: "recv", handle: 100, data: "two", seqno: 1 });
    const merged = new Uint8Array(a.length + b.length);
    merged.set(a, 0);
    merged.set(b, a.length);
    clientSocket!.write(merged);

    await waitFor(() => received.length === 2);
    expect(received).toEqual(["one", "two"]);
    await link.close();
  });

  it("fires onClose (no error) on a server-initiated close push", async () => {
    server = await FakeRhpServer.start();
    let clientSocket: Socket | undefined;
    server.onRequest((socket, req) => {
      if (req.type === "open") {
        clientSocket = socket;
        FakeRhpServer.send(socket, { type: "openReply", id: req.id, handle: 100, errCode: 0 });
      }
    });
    const transport = new RhpTcpTransport({ host: "127.0.0.1", port: server.port });
    const link = await transport.open({ family: "ax25", local: "M0LTE-7", remote: "MB7NPW-9" });

    let closedErr: Error | null | undefined = null;
    link.onClose((err) => {
      closedErr = err ?? undefined;
    });

    FakeRhpServer.send(clientSocket!, { type: "close", handle: 100, seqno: 0 });
    await waitFor(() => closedErr !== null);
    expect(closedErr).toBeUndefined(); // remote close -> no error
    await link.close();
  });

  it("fires onClose with an error when the transport drops", async () => {
    server = await FakeRhpServer.start();
    let clientSocket: Socket | undefined;
    server.onRequest((socket, req) => {
      if (req.type === "open") {
        clientSocket = socket;
        FakeRhpServer.send(socket, { type: "openReply", id: req.id, handle: 100, errCode: 0 });
      }
    });
    const transport = new RhpTcpTransport({ host: "127.0.0.1", port: server.port });
    const link = await transport.open({ family: "ax25", local: "M0LTE-7", remote: "MB7NPW-9" });

    let fired = false;
    link.onClose(() => {
      fired = true;
    });
    // Drop the underlying TCP connection abruptly.
    clientSocket!.destroy();

    await waitFor(() => fired);
    expect(fired).toBe(true);
    await link.close();
  });

  it("close() is idempotent and sends a close request", async () => {
    server = await FakeRhpServer.start();
    let closeCount = 0;
    server.onRequest((socket, req) => {
      if (req.type === "open") {
        FakeRhpServer.send(socket, { type: "openReply", id: req.id, handle: 100, errCode: 0 });
      } else if (req.type === "close") {
        closeCount++;
        FakeRhpServer.send(socket, { type: "closeReply", id: req.id, handle: req["handle"], errCode: 0 });
      }
    });
    const transport = new RhpTcpTransport({ host: "127.0.0.1", port: server.port });
    const link = await transport.open({ family: "ax25", local: "M0LTE-7", remote: "MB7NPW-9" });

    await link.close();
    await link.close(); // second call is a no-op
    // The close is sent fire-and-forget then the socket is torn down; give the
    // server a moment to observe the frame before asserting exactly one arrived.
    await waitFor(() => closeCount >= 1);
    expect(closeCount).toBe(1);
  });

  it("rejects open when the TCP connection is refused", async () => {
    // Port 1 on loopback should refuse (nothing listens there).
    const transport = new RhpTcpTransport({ host: "127.0.0.1", port: 1, replyTimeoutMs: 500 });
    await expect(
      transport.open({ family: "ax25", local: "M0LTE-7", remote: "MB7NPW-9" }),
    ).rejects.toBeInstanceOf(Error);
  });

  // A live node would need a real RHP host (pdn/XRouter on 9000) + a real
  // remote on the air — not available in CI. Marked skipped.
  it.skip("opens against a live RHP host (requires pdn/XRouter on :9000)", async () => {
    const transport = new RhpTcpTransport({ host: "127.0.0.1", port: 9000 });
    const link = await transport.open({ family: "ax25", local: "M0LTE-7", remote: "MB7NPW-9" });
    await link.close();
  });
});

/** Poll a predicate until true (or time out), letting the event loop run. */
async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}
