// WPS frame framing — the byte-level codec, mirroring the WhatsPac SPA's
// `ma()` (encode) and `cfe()` (decode) functions exactly.
//
// On-wire frame (both directions):
//
//   compressed:    0xC3  base64( zlib_deflate( JSON ) )  0xC3
//   uncompressed:  <raw JSON, UTF-8>                                (fallback)
//   then the sender appends 0x0D ('\r') as the frame terminator.
//
// The SPA only sends the compressed form when it is *strictly shorter* than the
// raw JSON, compared by JavaScript string length — so a tiny object such as
// {"t":"k"} goes out uncompressed. We reproduce that decision precisely.
//
// Deflate is zlib-wrapped (pako default: header 78 9c, level 6, window 15) —
// NOT raw deflate. See docs/wps-protocol.md §2.
//
// This module is runtime-agnostic (its only dependency is pako), so it can be
// shared with browser/Node WhatsPac clients.

import pako from "pako";

/** The compression-wrap marker: byte 0xC3 ('Ã', U+00C3), on both ends of a compressed payload. */
export const MARKER = 0xc3;

/** The frame terminator: byte 0x0D ('\r'), appended by the sender in both directions. */
export const TERMINATOR = 0x0d;

// --- base64, runtime-agnostic (Buffer on Node, btoa/atob in a browser) ---

function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64");
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(b64, "base64"));
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/**
 * Encode a JSON string into a WPS frame payload (without the trailing 0x0D).
 * Mirrors the SPA's `ma()`.
 */
export function encodePayload(json: string): Uint8Array {
  const b64 = bytesToBase64(pako.deflate(json, { level: 6 }));
  // SPA: r = MARKER + b64 + MARKER; compressed is used only when r.length <
  // json.length. Each marker is one JS char, so r.length === b64.length + 2.
  if (b64.length + 2 < json.length) {
    const out = new Uint8Array(b64.length + 2);
    out[0] = MARKER;
    for (let i = 0; i < b64.length; i++) out[i + 1] = b64.charCodeAt(i);
    out[out.length - 1] = MARKER;
    return out;
  }
  // Uncompressed fallback: the raw JSON as UTF-8.
  return textEncoder.encode(json);
}

/**
 * Decode a single WPS frame payload (without the trailing 0x0D) into its JSON
 * text. Mirrors the SPA's receive classifier + `cfe()`.
 */
export function decodePayloadText(frame: Uint8Array): string {
  const n = frame.length;
  if (n >= 2 && frame[0] === MARKER && frame[n - 1] === MARKER) {
    // Compressed: strip the single-byte markers; the middle is ASCII base64.
    let b64 = "";
    for (let i = 1; i < n - 1; i++) b64 += String.fromCharCode(frame[i]!);
    return pako.inflate(base64ToBytes(b64), { to: "string" });
  }
  // Uncompressed fallback: raw JSON (UTF-8).
  return textDecoder.decode(frame);
}
