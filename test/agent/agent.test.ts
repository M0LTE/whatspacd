import { describe, expect, it } from "vitest";
import { WhatspacAgent, type AgentConfig } from "../../src/agent/agent";
import type { ConnectScript } from "../../src/agent/connectScript";
import { Store, conversationId } from "../../src/store/store";
import type { WpsMessage } from "../../src/protocol/index";
import { FakeTimers, MockTransport, MockWps, type MockWpsApi } from "./mockWps";

const SCRIPT: ConnectScript = [
  { id: 1, hop: "node", cmd: "GB7NBH", val: "GB7NBH BPQ Packet Node" },
  { id: 2, hop: "WPS", cmd: "C MB7NPW-9", val: "*** Connected to WPS" },
];

function baseConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    family: "ax25",
    localCallsign: "M0LTE-7",
    whatsPacCallsign: "M0LTE",
    displayName: "Tom",
    clientVersion: 0.92,
    connectScript: SCRIPT,
    rhpPort: null,
    ...overrides,
  };
}

interface Harness {
  agent: WhatspacAgent;
  store: Store;
  transport: MockTransport;
  wps: MockWps;
  timers: FakeTimers;
  sent: WpsMessage[];
  events: string[];
}

function makeHarness(opts: {
  onConnect?: (c: WpsMessage, api: MockWpsApi) => void;
  onMessage?: (m: WpsMessage, api: MockWpsApi) => void;
  config?: Partial<AgentConfig>;
}): Harness {
  const store = new Store();
  const wps = new MockWps(SCRIPT, { onConnect: opts.onConnect, onMessage: opts.onMessage });
  const transport = new MockTransport(wps);
  const timers = new FakeTimers();
  const agent = new WhatspacAgent({
    transport,
    store,
    config: baseConfig(opts.config),
    timers,
    now: () => 1_700_000_900_000,
  });
  const sent: WpsMessage[] = [];
  const events: string[] = [];
  agent.events.on("sent", (m) => sent.push(m as WpsMessage));
  agent.events.on("status", (s) => events.push(`status:${s}`));
  agent.events.on("connected", () => events.push("connected"));
  agent.events.on("message", () => events.push("message"));
  agent.events.on("post", () => events.push("post"));
  agent.events.on("presence", () => events.push("presence"));
  return { agent, store, transport, wps, timers, sent, events };
}

const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

describe("WhatspacAgent — connect + ingest", () => {
  it("opens to the first hop, runs the script, sends the connect object, and ingests backfill", async () => {
    const h = makeHarness({
      onConnect: (_c, api) => {
        api.send({ t: "c", w: 1, mc: 1, pc: 1, v: 0.92 });
        api.send({ t: "pch", ch: [{ cid: "general", cn: "General" }] });
        api.send({ t: "o", o: ["M0ABC", "M0XYZ"] });
        api.send({ t: "he", h: [{ c: "M0ABC", n: "Alice", ts: 1_699_999_999_000 }] });
        api.send({ t: "cp", cid: "general", fc: "M0ABC", p: "hello world", ts: 1_700_000_500_000 });
        api.send({
          t: "m",
          fc: "M0ABC",
          tc: "M0LTE",
          m: "hi tom",
          ts: 1_700_000_000,
          _id: "1700000000000-M0ABC",
        });
      },
    });

    await h.agent.start();

    // Opened to the first connect-script hop, not MB7NPW-9 directly.
    expect(h.transport.lastOptions).toEqual({
      family: "ax25",
      local: "M0LTE-7",
      remote: "GB7NBH",
      port: null,
    });

    // The connect object carries identity + (zero, first-time) cursors, no cc.
    expect(h.wps.connectObjects).toHaveLength(1);
    expect(h.wps.connectObjects[0]).toEqual({
      t: "c",
      n: "Tom",
      c: "M0LTE",
      lm: 0,
      le: 0,
      led: 0,
      lhts: 0,
      v: 0.92,
    });

    // Backfill landed in the store.
    expect(h.store.listChannels().map((c) => c.cid)).toContain("general");
    expect(h.store.onlineCallsigns()).toEqual(["M0ABC", "M0XYZ"]);
    expect(h.store.listPosts("general").map((p) => p.p)).toEqual(["hello world"]);
    expect(h.store.listDirectMessages(conversationId("M0ABC", "M0LTE")).map((m) => m.m)).toEqual([
      "hi tom",
    ]);

    expect(h.events).toContain("connected");
    expect(h.events).toContain("presence");
    expect(h.events).toContain("post");
    expect(h.events).toContain("message");
    expect(h.agent.getStatus()).toBe("running");

    await h.agent.stop();
  });
});

describe("WhatspacAgent — keepalive (docs §7)", () => {
  it("sends an avatar enquiry on the first idle tick, then keepalives, resetting on activity", async () => {
    const h = makeHarness({ onConnect: (_c, api) => api.send({ t: "c", w: 0, mc: 0, pc: 0, v: 0.92 }) });
    await h.agent.start();
    h.sent.length = 0; // ignore the connect object

    h.timers.tickIntervals(); // first idle tick -> avatar enquiry
    h.timers.tickIntervals(); // second idle tick -> keepalive
    await flush();
    expect(h.sent.map((m) => m.t)).toEqual(["ae", "k"]);
    expect(h.sent[0]).toMatchObject({ t: "ae", co: 1 });

    h.sent.length = 0;
    await h.agent.postToChannel("general", "hey"); // genuine activity resets idle
    h.timers.tickIntervals(); // first idle tick again -> avatar enquiry
    await flush();
    expect(h.sent.map((m) => m.t)).toEqual(["cp", "ae"]);

    await h.agent.stop();
  });
});

describe("WhatspacAgent — resilient startup", () => {
  it("does not throw when the initial RHP open fails; schedules a reconnect", async () => {
    const store = new Store();
    const timers = new FakeTimers();
    let opens = 0;
    const transport = {
      open: () => {
        opens += 1;
        return Promise.reject(new Error("ECONNREFUSED"));
      },
    };
    const agent = new WhatspacAgent({ transport, store, config: baseConfig(), timers });

    await expect(agent.start()).resolves.toBeUndefined();
    expect(agent.getStatus()).toBe("reconnecting");
    expect(opens).toBe(1);

    timers.runTimeouts(); // backoff fires -> tries again (still refused)
    await flush();
    expect(opens).toBe(2);

    await agent.stop();
  });
});

describe("WhatspacAgent — reconnect + resync", () => {
  it("reconnects after a drop and sends updated delta cursors", async () => {
    const h = makeHarness({
      onConnect: (_c, api) => {
        api.send({ t: "c", w: 0, mc: 0, pc: 0, v: 0.92 });
        api.send({ t: "cs", s: 1, cid: "general", pc: 1 }); // subscribed
        api.send({ t: "cp", cid: "general", fc: "M0ABC", p: "first", ts: 1_700_000_500_000 });
        api.send({
          t: "m",
          fc: "M0ABC",
          tc: "M0LTE",
          m: "hi",
          ts: 1_700_000_000,
          _id: "1700000000000-M0ABC",
        });
      },
    });

    await h.agent.start();
    expect(h.wps.connectObjects).toHaveLength(1);

    h.wps.link.drop(new Error("link lost"));
    expect(h.agent.getStatus()).toBe("reconnecting");

    h.timers.runTimeouts(); // fire the reconnect backoff
    await flush();

    expect(h.wps.connectObjects).toHaveLength(2);
    const second = h.wps.connectObjects[1]!;
    expect(second.lm).toBe(1_700_000_000); // newest DM ts
    expect(second.cc).toEqual([{ cid: "general", lp: 1_700_000_500_000, le: 0, led: 0 }]);

    await h.agent.stop();
  });
});
