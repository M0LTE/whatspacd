// Message-level WPS codec: typed messages <-> on-wire frames, plus a streaming
// frame reader that handles the 0x0D-delimited byte stream coming off the link.

import { decodePayloadText, encodePayload, TERMINATOR } from "./framing";
import type { WpsMessage } from "./messages";

/** Thrown when a frame cannot be decoded into a WPS message. */
export class WpsDecodeError extends Error {
  override readonly name = "WpsDecodeError";
}

/**
 * Encode a message into a complete on-wire frame, including the trailing 0x0D
 * terminator — ready to hand to the transport's `send`. Generic over the input
 * so both the loose {@link WpsMessage} and the typed message interfaces (which
 * lack a string index signature) can be passed without a cast.
 */
export function encodeFrame<T extends { t: string }>(msg: T): Uint8Array {
  const payload = encodePayload(JSON.stringify(msg));
  const out = new Uint8Array(payload.length + 1);
  out.set(payload, 0);
  out[payload.length] = TERMINATOR;
  return out;
}

/** Decode a single frame payload (without the terminator) into a message. */
export function decodeFrame(payload: Uint8Array): WpsMessage {
  let text: string;
  try {
    text = decodePayloadText(payload);
  } catch (cause) {
    throw new WpsDecodeError("failed to decompress/decode frame", { cause });
  }

  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch (cause) {
    throw new WpsDecodeError("frame payload is not valid JSON", { cause });
  }

  if (obj === null || typeof obj !== "object" || typeof (obj as { t?: unknown }).t !== "string") {
    throw new WpsDecodeError("frame is not a WPS message (missing string `t`)");
  }
  return obj as WpsMessage;
}

/**
 * Accumulates raw bytes from the link and yields decoded messages as complete
 * `\r`-terminated frames arrive. Mirrors the SPA receive accumulator
 * (docs/wps-protocol.md §2.4): split on 0x0D, decode each non-empty segment,
 * keep any trailing partial frame buffered for the next chunk.
 */
export class FrameReader {
  private buffer: Uint8Array = new Uint8Array(0);

  /** Feed a chunk of received bytes; returns any messages newly completed by it. */
  push(chunk: Uint8Array): WpsMessage[] {
    const messages: WpsMessage[] = [];

    let combined: Uint8Array;
    if (this.buffer.length === 0) {
      combined = chunk;
    } else {
      combined = new Uint8Array(this.buffer.length + chunk.length);
      combined.set(this.buffer, 0);
      combined.set(chunk, this.buffer.length);
    }

    let start = 0;
    for (let i = 0; i < combined.length; i++) {
      if (combined[i] === TERMINATOR) {
        if (i > start) {
          messages.push(decodeFrame(combined.subarray(start, i)));
        }
        start = i + 1;
      }
    }

    // Keep the trailing partial frame (copied, so we don't retain `combined`).
    this.buffer = start < combined.length ? combined.slice(start) : new Uint8Array(0);
    return messages;
  }

  /** Discard any buffered partial frame (e.g. on reconnect). */
  reset(): void {
    this.buffer = new Uint8Array(0);
  }
}
