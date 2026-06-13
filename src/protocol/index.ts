// The WPS application-protocol codec — the runtime-agnostic shared artifact.
//
// Framing (deflate + base64 + `Ã…Ã` wrap, `\r`-delimited; uncompressed fallback),
// the typed message model, and a streaming frame reader.

export {
  MARKER,
  TERMINATOR,
  encodePayload,
  decodePayloadText,
} from "./framing";

export { encodeFrame, decodeFrame, FrameReader, WpsDecodeError } from "./codec";

export * from "./messages";
