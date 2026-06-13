// The LAN/phone web head — a Hono JSON/SSE API + embedded SPA over the daemon's
// shared agent + store.
//
// Surfaced on the owner's WLAN directly, or reverse-proxied by pdn's app-gateway
// under /apps/whatspac (the gateway strips the prefix, so this app lives at its
// own root and the SPA uses RELATIVE URLs). Trust model: bound 127.0.0.1 only;
// when behind the gateway, requests carry X-Pdn-User / X-Pdn-Scope and mutating
// routes require operate|admin; standalone (no scope header) is owner-trusted
// loopback and allowed.

import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type {
  Callsign,
  ChannelPost,
  DirectMessage,
} from "../../protocol/index";
import { conversationId, Store } from "../../store/store";
import { INDEX_HTML } from "./ui";

/**
 * The slice of {@link WhatspacAgent} this head drives. A structural interface so
 * tests can pass a lightweight stub; the real agent satisfies it.
 */
export interface WebAgent {
  readonly events: {
    on(event: "status", listener: (status: string) => void): () => void;
    on(event: "post", listener: (p: ChannelPost) => void): () => void;
    on(event: "message", listener: (m: DirectMessage) => void): () => void;
    on(event: "presence", listener: (online: Callsign[]) => void): () => void;
  };
  getStatus(): string;
  postToChannel(cid: string, text: string): Promise<void>;
  sendDirectMessage(tc: Callsign, text: string): Promise<void>;
  subscribeChannel(cid: string): Promise<void>;
  unsubscribeChannel(cid: string): Promise<void>;
}

export interface WebAppDeps {
  agent: WebAgent;
  store: Store;
  /** The daemon's own WhatsPac callsign — the perspective for DMs / status. */
  myCallsign: Callsign;
}

/** A scope ≥ operate may mutate; read (or no scope at all) may only read. */
function mayMutate(scope: string | undefined): boolean {
  // Absent header = standalone owner-trusted loopback → allow.
  if (scope === undefined || scope === "") return true;
  return scope === "operate" || scope === "admin";
}

/** Decorate a post row with the sender's display name from the ham table. */
function withSenderName(store: Store, p: { fc: Callsign }): { senderName: string | null } {
  return { senderName: store.getHam(p.fc)?.n ?? null };
}

/**
 * Build the web head's Hono app over the shared agent + store. Pure (no port),
 * so tests drive it with `app.request(...)`.
 */
export function buildWebApp(deps: WebAppDeps): Hono {
  const { agent, store, myCallsign } = deps;
  const app = new Hono();

  // --- gate: POSTs require operate|admin when a scope header is present ---
  app.use("*", async (c, next) => {
    if (c.req.method === "POST") {
      const scope = c.req.header("X-Pdn-Scope");
      if (!mayMutate(scope)) {
        return c.json({ error: "forbidden: operate scope required" }, 403);
      }
    }
    await next();
  });

  // --- status / identity ---
  app.get("/api/status", (c) =>
    c.json({
      status: agent.getStatus(),
      callsign: myCallsign,
      viewer: c.req.header("X-Pdn-User") || null,
      scope: c.req.header("X-Pdn-Scope") || null,
    }),
  );

  // Presence + the known display names, for the roster (read-derived from store).
  app.get("/api/online", (c) => {
    const online = store.onlineCallsigns();
    const hams: Record<string, string> = {};
    for (const call of online) {
      const n = store.getHam(call)?.n;
      if (n) hams[call] = n;
    }
    return c.json({ online, hams });
  });

  // --- channels ---
  app.get("/api/channels", (c) => c.json(store.listChannels()));

  app.get("/api/channels/:cid/posts", (c) => {
    const cid = c.req.param("cid");
    const posts = store.listPosts(cid).map((p) => ({ ...p, ...withSenderName(store, p) }));
    return c.json(posts);
  });

  app.post("/api/channels/:cid/posts", async (c) => {
    const cid = c.req.param("cid");
    const body = await c.req.json<{ text?: unknown }>().catch(() => ({ text: undefined }));
    const text = typeof body.text === "string" ? body.text : "";
    if (text.trim() === "") return c.json({ error: "text required" }, 400);
    await agent.postToChannel(cid, text);
    return c.json({ ok: true }, 201);
  });

  app.post("/api/channels/:cid/subscription", async (c) => {
    const cid = c.req.param("cid");
    const body = await c.req.json<{ subscribed?: unknown }>().catch(() => ({ subscribed: undefined }));
    if (typeof body.subscribed !== "boolean") {
      return c.json({ error: "subscribed (boolean) required" }, 400);
    }
    if (body.subscribed) await agent.subscribeChannel(cid);
    else await agent.unsubscribeChannel(cid);
    return c.json({ ok: true, subscribed: body.subscribed });
  });

  // --- direct messages ---
  app.get("/api/conversations", (c) => c.json(store.listConversations(myCallsign)));

  app.get("/api/conversations/:peer/messages", (c) => {
    const peer = c.req.param("peer");
    return c.json(store.listDirectMessages(conversationId(myCallsign, peer)));
  });

  app.post("/api/dm", async (c) => {
    const body = await c.req
      .json<{ to?: unknown; text?: unknown }>()
      .catch(() => ({ to: undefined, text: undefined }));
    const to = typeof body.to === "string" ? body.to : "";
    const text = typeof body.text === "string" ? body.text : "";
    if (to.trim() === "" || text.trim() === "") {
      return c.json({ error: "to and text required" }, 400);
    }
    await agent.sendDirectMessage(to, text);
    return c.json({ ok: true }, 201);
  });

  // --- live updates (SSE) ---
  // Named SSE events with JSON data; every agent listener is unsubscribed when
  // the client disconnects (the stream's abort signal aborts the body).
  app.get("/api/events", (c) =>
    streamSSE(c, async (stream) => {
      const offs: Array<() => void> = [];
      let closed = false;
      const send = (event: string, data: unknown): void => {
        if (closed) return;
        void stream.writeSSE({ event, data: JSON.stringify(data) }).catch(() => {});
      };

      offs.push(agent.events.on("status", (status) => send("status", { status })));
      offs.push(agent.events.on("post", (p) => send("post", p)));
      offs.push(agent.events.on("message", (m) => send("message", m)));
      offs.push(agent.events.on("presence", (online) => send("presence", { online })));

      // Opening frame so the client's link dot lights immediately.
      send("status", { status: agent.getStatus() });

      const cleanup = (): void => {
        if (closed) return;
        closed = true;
        for (const off of offs) off();
      };
      stream.onAbort(cleanup);

      // Hold the stream open until the client disconnects (abort resolves it).
      await new Promise<void>((resolve) => {
        stream.onAbort(resolve);
      });
      cleanup();
    }),
  );

  // --- the SPA ---
  app.get("/", (c) => c.html(INDEX_HTML));

  return app;
}
