import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  FrameReader,
  MARKER,
  TERMINATOR,
  WpsDecodeError,
  decodeFrame,
  encodeFrame,
  type WpsMessage,
} from "../../src/protocol/index";

interface Fixture {
  name: string;
  t: string;
  direction: string;
  note: string;
  decoded: WpsMessage;
  wire: {
    json: string;
    base64_deflate: string;
    encoding_mode: "compressed" | "uncompressed-fallback";
    frame_string: string;
  };
}

const fixturesDir = fileURLToPath(new URL("../fixtures", import.meta.url));
const fixtures: Fixture[] = readdirSync(fixturesDir)
  .filter((f) => f.endsWith(".json"))
  .map((f) => JSON.parse(readFileSync(`${fixturesDir}/${f}`, "utf8")) as Fixture);

/** The exact on-wire frame bytes (incl. terminator) for a fixture. */
function expectedFrameBytes(fx: Fixture): Uint8Array {
  if (fx.wire.encoding_mode === "compressed") {
    const b64 = Buffer.from(fx.wire.base64_deflate, "ascii");
    const out = new Uint8Array(b64.length + 3);
    out[0] = MARKER;
    out.set(b64, 1);
    out[b64.length + 1] = MARKER;
    out[b64.length + 2] = TERMINATOR;
    return out;
  }
  const json = Buffer.from(fx.wire.json, "utf8");
  const out = new Uint8Array(json.length + 1);
  out.set(json, 0);
  out[json.length] = TERMINATOR;
  return out;
}

describe("WPS codec — golden fixtures", () => {
  it("loaded the full fixture set", () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(41);
  });

  for (const fx of fixtures) {
    describe(`${fx.name} (t=${fx.t}, ${fx.wire.encoding_mode})`, () => {
      it("wire.json is the compact JSON.stringify of decoded", () => {
        expect(JSON.stringify(fx.decoded)).toBe(fx.wire.json);
      });

      it("decodes the canonical wire frame back to `decoded`", () => {
        const reader = new FrameReader();
        const msgs = reader.push(expectedFrameBytes(fx));
        expect(msgs).toHaveLength(1);
        expect(msgs[0]).toEqual(fx.decoded);
      });

      it("encodes `decoded` to the canonical wire frame, byte-identical", () => {
        const frame = encodeFrame(fx.decoded);
        expect(Buffer.from(frame).equals(Buffer.from(expectedFrameBytes(fx)))).toBe(true);
      });

      it("chooses the documented compression mode and round-trips", () => {
        const frame = encodeFrame(fx.decoded);
        const compressed = frame[0] === MARKER;
        expect(compressed).toBe(fx.wire.encoding_mode === "compressed");
        const back = decodeFrame(frame.subarray(0, frame.length - 1));
        expect(back).toEqual(fx.decoded);
      });
    });
  }
});

describe("FrameReader streaming", () => {
  const a = encodeFrame({ t: "k" });
  const b = encodeFrame({ t: "cp", cid: "x", fc: "M0LTE", p: "hello", ts: 1700000000000 });

  it("yields multiple frames from one chunk", () => {
    const reader = new FrameReader();
    const both = new Uint8Array(a.length + b.length);
    both.set(a, 0);
    both.set(b, a.length);
    const msgs = reader.push(both);
    expect(msgs.map((m) => m.t)).toEqual(["k", "cp"]);
  });

  it("buffers a frame split across chunks", () => {
    const reader = new FrameReader();
    const split = Math.floor(b.length / 2);
    expect(reader.push(b.subarray(0, split))).toHaveLength(0);
    const msgs = reader.push(b.subarray(split));
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.t).toBe("cp");
  });

  it("ignores empty segments between terminators", () => {
    const reader = new FrameReader();
    const msgs = reader.push(new Uint8Array([TERMINATOR, TERMINATOR, ...a, TERMINATOR]));
    expect(msgs.map((m) => m.t)).toEqual(["k"]);
  });

  it("survives a reset discarding a partial frame", () => {
    const reader = new FrameReader();
    reader.push(b.subarray(0, 3));
    reader.reset();
    const msgs = reader.push(a);
    expect(msgs.map((m) => m.t)).toEqual(["k"]);
  });
});

describe("decodeFrame errors", () => {
  it("rejects a frame that is not valid JSON", () => {
    expect(() => decodeFrame(new TextEncoder().encode("{not json"))).toThrow(WpsDecodeError);
  });

  it("rejects a JSON value with no string `t`", () => {
    expect(() => decodeFrame(new TextEncoder().encode('{"x":1}'))).toThrow(WpsDecodeError);
  });
});
