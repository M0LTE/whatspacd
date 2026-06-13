# whatspacd

A persistent **WhatsPac client daemon**.

WhatsPac (Kevin M0AHN) is a browser SPA with no engine of its own and — its defining limitation — **no persistence**: the over-the-air session to the central WhatsPac Server (WPS, `MB7NPW-9`) lives and dies with the browser tab. `whatspacd` fixes that structurally: it is a long-running service that **holds the WPS link continuously, persists all state**, and presents it through **two heads** — a web UI (LAN/phone) and a line-based **RF terminal** reachable from any dumb packet connection (`C WHATSPAC`).

It is **not** a re-host of the WhatsPac SPA. It speaks the WPS application protocol end-to-end over a transparent AX.25 stream obtained from a packet node via **RHP** (Radio Host Protocol).

## Runs anywhere there's an RHP host

`whatspacd` is **engine-agnostic**. The node is just an RHP endpoint, so it works:

- **standalone** against **XRouter** or **LinBPQ** (RHP over TCP) — keep your existing engine, gain a persistent WhatsPac client;
- as a **[packet.net](https://github.com/m0lte/packet.net) (pdn) app** — pdn integration (app-gateway web surface, `pdn-app/1` RF session, supervised lifecycle) is an *optional adapter*, not a requirement.

> Design record / ADR: [`packet.net:docs/whatspac-client-design.md`](https://github.com/m0lte/packet.net/blob/main/docs/whatspac-client-design.md). The WPS application protocol is documented in [`docs/wps-protocol.md`](docs/wps-protocol.md) (re-derived from the production SPA bundle); the pdn platform seams in [`docs/platform-contracts.md`](docs/platform-contracts.md).

## Architecture

```
RHP host (pdn / XRouter / BPQ) ──RHP──► [ agent: WPS link + SQLite store ] ──► web head   (HTTP + SSE UI)
                                                                            └──► RF head    (pdn-app/1 line session: C WHATSPAC)
```

- **`src/protocol`** — the WPS application-protocol codec + typed message model. Runtime-agnostic (only `pako`), so it is shareable with browser/Node clients. The crown jewel; pinned by golden fixtures.
- **`src/rhp`** — the engine-agnostic RHP client transport (TCP now; WebSocket if an engine needs it).
- **`src/agent`** — the persistent agent: link lifecycle, connect-script runner, codec wiring, keepalive, reconnect/resync.
- **`src/store`** — SQLite persistence (`node:sqlite`, no native dependency).
- **`src/heads/web`** — the LAN/phone head: a Hono JSON+SSE API and an embedded SPA, served loopback-only (surfaced on the WLAN directly or via pdn's app-gateway).
- **`src/heads/rf`** — the RF-terminal head: a line-oriented session over the `pdn-app/1` wire (`C WHATSPAC`).
- pdn integration is an *optional adapter*, not a dependency: env-var fallbacks (`src/config.ts`), the [`pdn-app.yaml`](pdn-app.yaml) manifest, and gateway-aware heads.

## Develop

```sh
npm install
npm run typecheck    # tsc --noEmit
npm test             # vitest
npm run dev          # tsx watch src/main.ts
```

Requires Node ≥ 22.5 (uses the built-in `node:sqlite`). Ships as a single ESM bundle (`npm run build` → `dist/main.js`) or a self-contained executable (Node SEA) for standalone installs — see [`docs/packaging.md`](docs/packaging.md).

## Status

The ADR §5 slices are built and tested against a mock WPS: the codec (1), the persistent agent + store + RHP-over-TCP client + daemon (2), the RF terminal head (3), the LAN/phone web head (4), and packaging (5). 253 tests; the full two-headed daemon runs end-to-end.

The WPS protocol is re-derived from the production SPA bundle and pinned by 41 round-tripping fixtures. **What remains is radio-gated:** Slice 0's on-air capture against the live WPS (`MB7NPW-9`) — to confirm the value-level details still marked *(verify)* in [`docs/wps-protocol.md`](docs/wps-protocol.md) §9 (connect-reply key completeness, the pairing `p` reply, `cu`'s server response, direct-open acceptance, backfill ordering). The thin codec + golden fixtures are designed to absorb those corrections.
