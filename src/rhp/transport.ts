// The RHP transport seam.
//
// whatspacd is engine-agnostic: the node is just an RHP host that hands back a
// transparent connected-mode AX.25 (or NET-ROM) byte stream. Everything above
// this seam — the connect-script runner, the WPS codec, the agent — works over
// an `RhpLink` and never touches RHP wire details, so the same agent runs
// against pdn, XRouter or LinBPQ. The concrete RHP-over-TCP client lives in
// `client.ts`; tests use an in-memory link.

export type Callsign = string;
export type AddressFamily = "ax25" | "netrom";

export interface RhpOpenOptions {
  family: AddressFamily;
  /** The source callsign. For NET-ROM (L4) this is "<callsign>@<nodeCall>". */
  local: Callsign;
  /** The remote to open to — the FIRST connect-script hop's `cmd`, not MB7NPW-9 directly. */
  remote: Callsign;
  /** RHP port label (engine interface selector); null lets the host choose. */
  port?: string | null;
}

/**
 * A live connected-mode session as a duplex byte channel. Bytes flow verbatim
 * (Latin-1 clean) in both directions; framing/codec live above this seam.
 */
export interface RhpLink {
  /** Send raw bytes to the remote (the caller is responsible for framing). */
  send(data: Uint8Array): Promise<void>;
  /** Close the session. Idempotent. */
  close(): Promise<void>;
  /** Subscribe to inbound bytes. */
  onData(listener: (chunk: Uint8Array) => void): void;
  /** Subscribe to session teardown (remote close, transport drop, or local close). */
  onClose(listener: (err?: Error) => void): void;
}

/** Opens outbound connected-mode sessions through an RHP host. */
export interface RhpTransport {
  open(opts: RhpOpenOptions): Promise<RhpLink>;
}
