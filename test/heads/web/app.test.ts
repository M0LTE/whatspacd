import { describe, expect, it } from "vitest";
import { buildWebApp, type WebAgent } from "../../../src/heads/web/app";
import { Store, conversationId } from "../../../src/store/store";
import { TypedEmitter } from "../../../src/util/emitter";
import type { AgentEvents } from "../../../src/agent/agent";
import type { Callsign } from "../../../src/protocol/index";

const ME = "M0LTE";

interface StubCalls {
  posts: Array<{ cid: string; text: string }>;
  dms: Array<{ to: Callsign; text: string }>;
  subs: Array<{ cid: string; subscribed: boolean }>;
}

/** A stub agent: a real TypedEmitter for events + captured method calls. */
function makeAgent(): {
  agent: WebAgent;
  events: TypedEmitter<AgentEvents>;
  calls: StubCalls;
} {
  const events = new TypedEmitter<AgentEvents>();
  const calls: StubCalls = { posts: [], dms: [], subs: [] };
  const agent: WebAgent = {
    events,
    getStatus: () => "running",
    postToChannel: async (cid, text) => void calls.posts.push({ cid, text }),
    sendDirectMessage: async (to, text) => void calls.dms.push({ to, text }),
    subscribeChannel: async (cid) => void calls.subs.push({ cid, subscribed: true }),
    unsubscribeChannel: async (cid) => void calls.subs.push({ cid, subscribed: false }),
  };
  return { agent, events, calls };
}

function seedStore(): Store {
  const store = new Store();
  store.upsertChannelHeader({ cid: "general", cn: "General" });
  store.upsertChannelHeader({ cid: "tech", cn: "Tech Talk" });
  store.setChannelSubscribed("general", true);
  store.upsertHam({ c: "G0ABC", n: "Alice", ts: 1000 });
  store.putPost({ t: "cp", cid: "general", fc: "G0ABC", p: "hello world", ts: 1_700_000_000_000 });
  store.putDirectMessage({ t: "m", fc: "G0ABC", tc: ME, m: "hi tom", ts: 1_700_000_000 });
  store.setOnline(["G0ABC", "G7XYZ"]);
  return store;
}

function build() {
  const { agent, events, calls } = makeAgent();
  const store = seedStore();
  const app = buildWebApp({ agent, store, myCallsign: ME });
  return { app, agent, events, calls, store };
}

const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

describe("buildWebApp — GET routes", () => {
  it("GET /api/status returns status + callsign", async () => {
    const { app } = build();
    const res = await app.request("/api/status");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "running", callsign: ME });
  });

  it("GET /api/channels returns the seeded channels", async () => {
    const { app } = build();
    const res = await app.request("/api/channels");
    const body = (await res.json()) as Array<{ cid: string; cn: string | null; subscribed: boolean }>;
    expect(body.map((c) => c.cid)).toEqual(["general", "tech"]);
    expect(body.find((c) => c.cid === "general")?.subscribed).toBe(true);
  });

  it("GET /api/channels/:cid/posts includes the sender display name", async () => {
    const { app } = build();
    const res = await app.request("/api/channels/general/posts");
    const body = (await res.json()) as Array<{ fc: string; p: string; senderName: string | null }>;
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({ fc: "G0ABC", p: "hello world", senderName: "Alice" });
  });

  it("GET /api/conversations lists DM conversations", async () => {
    const { app } = build();
    const res = await app.request("/api/conversations");
    const body = (await res.json()) as Array<{ peer: string; lastText: string }>;
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({ peer: "G0ABC", lastText: "hi tom" });
  });

  it("GET /api/conversations/:peer/messages returns that conversation", async () => {
    const { app } = build();
    const res = await app.request("/api/conversations/G0ABC/messages");
    const body = (await res.json()) as Array<{ m: string; sid: string }>;
    expect(body).toHaveLength(1);
    expect(body[0]?.m).toBe("hi tom");
    expect(body[0]?.sid).toBe(conversationId(ME, "G0ABC"));
  });

  it("GET /api/online returns presence + known names", async () => {
    const { app } = build();
    const res = await app.request("/api/online");
    const body = (await res.json()) as { online: string[]; hams: Record<string, string> };
    expect(body.online).toEqual(["G0ABC", "G7XYZ"]);
    expect(body.hams).toMatchObject({ G0ABC: "Alice" });
  });
});

describe("buildWebApp — POST routes invoke the agent", () => {
  it("POST /api/channels/:cid/posts calls postToChannel", async () => {
    const { app, calls } = build();
    const res = await app.request("/api/channels/general/posts", json({ text: "yo" }));
    expect(res.status).toBe(201);
    expect(calls.posts).toEqual([{ cid: "general", text: "yo" }]);
  });

  it("POST /api/dm calls sendDirectMessage", async () => {
    const { app, calls } = build();
    const res = await app.request("/api/dm", json({ to: "G0ABC", text: "hey" }));
    expect(res.status).toBe(201);
    expect(calls.dms).toEqual([{ to: "G0ABC", text: "hey" }]);
  });

  it("POST /api/channels/:cid/subscription subscribes / unsubscribes", async () => {
    const { app, calls } = build();
    await app.request("/api/channels/tech/subscription", json({ subscribed: true }));
    await app.request("/api/channels/tech/subscription", json({ subscribed: false }));
    expect(calls.subs).toEqual([
      { cid: "tech", subscribed: true },
      { cid: "tech", subscribed: false },
    ]);
  });

  it("rejects empty post text with 400", async () => {
    const { app, calls } = build();
    const res = await app.request("/api/channels/general/posts", json({ text: "   " }));
    expect(res.status).toBe(400);
    expect(calls.posts).toHaveLength(0);
  });
});

describe("buildWebApp — scope gating", () => {
  it("403s a mutating route under X-Pdn-Scope: read", async () => {
    const { app, calls } = build();
    const res = await app.request("/api/channels/general/posts", {
      ...json({ text: "no" }),
      headers: { "content-type": "application/json", "X-Pdn-Scope": "read" },
    });
    expect(res.status).toBe(403);
    expect(calls.posts).toHaveLength(0);
  });

  it("allows a mutating route under X-Pdn-Scope: operate", async () => {
    const { app, calls } = build();
    const res = await app.request("/api/channels/general/posts", {
      ...json({ text: "ok" }),
      headers: { "content-type": "application/json", "X-Pdn-Scope": "operate" },
    });
    expect(res.status).toBe(201);
    expect(calls.posts).toEqual([{ cid: "general", text: "ok" }]);
  });

  it("allows a mutating route when no scope header is present (standalone)", async () => {
    const { app, calls } = build();
    const res = await app.request("/api/channels/general/posts", json({ text: "ok" }));
    expect(res.status).toBe(201);
    expect(calls.posts).toHaveLength(1);
  });

  it("read-only GETs are never gated", async () => {
    const { app } = build();
    const res = await app.request("/api/channels", { headers: { "X-Pdn-Scope": "read" } });
    expect(res.status).toBe(200);
  });

  it("surfaces the viewer identity from X-Pdn-User", async () => {
    const { app } = build();
    const res = await app.request("/api/status", { headers: { "X-Pdn-User": "G7XYZ", "X-Pdn-Scope": "read" } });
    expect(await res.json()).toMatchObject({ viewer: "G7XYZ", scope: "read" });
  });
});

describe("buildWebApp — SSE + SPA", () => {
  it("GET /api/events is an event-stream", async () => {
    const { app } = build();
    const ctrl = new AbortController();
    const res = await app.request("/api/events", { signal: ctrl.signal });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    ctrl.abort();
  });

  it("GET / returns the SPA HTML", async () => {
    const { app } = build();
    const res = await app.request("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("WhatsPac");
  });
});
