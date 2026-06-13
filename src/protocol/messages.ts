// The WPS application-protocol message model.
//
// Every message is a JSON object with a `t` type discriminator and short-key
// fields. The interfaces below are the code-confirmed shapes from
// docs/wps-protocol.md §3. Direction-specific fields (a few `t` values are used
// in both directions with different shapes) are marked optional and annotated.
//
// Field names are the literal short keys WPS uses on the wire — do not rename.

/** An AX.25 callsign, optionally with an SSID (e.g. "M0LTE", "M0LTE-7"). */
export type Callsign = string;
/** A Unix timestamp. WPS mixes seconds and milliseconds by field — see each comment. */
export type Timestamp = number;

// ---- Session ----

/** `c` (→) connect/login object. See docs/wps-protocol.md §5. */
export interface ConnectOut {
  t: "c";
  /** user's display name */
  n: string;
  /** the user's WhatsPac callsign */
  c: Callsign;
  /** last DM ts (seconds) | 0 */
  lm: Timestamp;
  /** last DM-emoji ts (ms) | 0 */
  le: Timestamp;
  /** last DM-edit ts (ms) | 0 */
  led: Timestamp;
  /** last ham-name ts (ms) | 0 */
  lhts: Timestamp;
  /** client version (0.92 in the analysed bundle) */
  v: number;
  /** per-channel delta cursors; omitted when there are no subscriptions */
  cc?: ChannelCursor[];
}

/** A per-channel delta cursor in the connect object's `cc` array. */
export interface ChannelCursor {
  cid: string;
  /** last post ts in this channel (ms) */
  lp: Timestamp;
  /** last post-emoji ts (ms) */
  le: Timestamp;
  /** last post-edit ts (ms) */
  led: Timestamp;
}

/** `c` (←) connect reply. */
export interface ConnectReply {
  t: "c";
  /** 1 = new user, 0 = returning */
  w: 0 | 1;
  /** message count */
  mc: number;
  /** post count */
  pc: number;
  /** server version */
  v: number;
}

/** `k` (→) keepalive. */
export interface Keepalive {
  t: "k";
}

// ---- Users / presence ----

export interface UserObject {
  tc: Callsign;
  n?: string;
  ls?: Timestamp;
  [key: string]: unknown;
}

/** `u` (←) user object(s). */
export interface UserList {
  t: "u";
  u: UserObject[];
}

/** `o` (←) full online-callsign list. */
export interface OnlineList {
  t: "o";
  o: Callsign[];
}

/** `uc` (←) user connected. */
export interface UserConnected {
  t: "uc";
  c: Callsign;
}

/** `ud` (←) user disconnected. */
export interface UserDisconnected {
  t: "ud";
  c: Callsign;
}

/** `ue` user enquiry (→ `{c}`) / reply (← `{tc,r,n,ls}`). */
export interface UserEnquiry {
  t: "ue";
  /** out: the callsign being enquired about */
  c?: Callsign;
  /** in: the target callsign */
  tc?: Callsign;
  /** in: found? */
  r?: boolean;
  /** in: name */
  n?: string;
  /** in: last seen */
  ls?: Timestamp;
}

export interface HamName {
  c: Callsign;
  n: string;
  ts: Timestamp;
}

/** `he` ham-name enquiry (→ `{h:[callsign]}`) / reply (← `{h:[{c,n,ts}]}`). */
export interface HamEnquiry {
  t: "he";
  h: Callsign[] | HamName[];
}

/** `s` (←) stats blob. */
export interface Stats {
  t: "s";
  s: Record<string, unknown>;
}

/** `p` pairing request (→ `{fc}`) / reply (←). */
export interface Pairing {
  t: "p";
  fc?: Callsign;
  [key: string]: unknown;
}

// ---- Direct messages (1:1) ----

/** `m` (↔) a direct message. `ts` is epoch **seconds**; `_id` = `"${epochMs}-${fc}"`. */
export interface DirectMessage {
  t: "m";
  fc: Callsign;
  tc: Callsign;
  m: string;
  ts: Timestamp;
  _id?: string;
  /** reply-to */
  r?: string;
}

/** `mb` (←) DM backfill batch. */
export interface DmBackfill {
  t: "mb";
  md: { mc: number; mt: number };
  m: DirectMessage[];
}

/** `med` (↔) DM edit. `edts` = edit ts (ms). */
export interface DmEdit {
  t: "med";
  _id: string;
  m: string;
  edts: Timestamp;
}

/** `medb` (←) DM edit batch. */
export interface DmEditBatch {
  t: "medb";
  med: Array<{ _id: string; m: string; edts: Timestamp }>;
}

/** `mr` (←) DM delivery receipt. */
export interface DmReceipt {
  t: "mr";
  _id: string;
}

/** `mem` (↔) DM emoji react. `a` = 1 add / 0 remove. */
export interface DmEmoji {
  t: "mem";
  a: 0 | 1;
  _id: string;
  e: string;
  ets: Timestamp;
}

/** `memb` (←) DM emoji batch. */
export interface DmEmojiBatch {
  t: "memb";
  mem: Array<{ a: 0 | 1; _id: string; e: string; ets: Timestamp }>;
}

// ---- Channels & posts ----

export interface ChannelHeader {
  cid: string;
  cn?: string;
  [key: string]: unknown;
}

/** `pch` (←) channel header / list. */
export interface ChannelHeaders {
  t: "pch";
  ch: ChannelHeader[];
}

/** `cs` channel subscribe/unsubscribe (→) and reply (←). */
export interface ChannelSubscribe {
  t: "cs";
  /** 1 = subscribe, 0 = unsubscribe */
  s: 0 | 1;
  cid: string;
  /** out (subscribe): last-channel-post ts cursor */
  lcp?: Timestamp;
  /** in (reply): available post count */
  pc?: number;
}

/** `cp` (↔) a channel post. `ts` is epoch **ms**; local `_id` = `"${ts}-${fc}"`. */
export interface ChannelPost {
  t: "cp";
  cid: string;
  fc: Callsign;
  p: string;
  ts: Timestamp;
  /** reply-to ts */
  rts?: Timestamp;
  /** reply-to callsign */
  rfc?: Callsign;
  /** @-mentioned callsigns */
  at?: Callsign[];
  _id?: string;
}

/** `cpb` channel-post backfill: request (→ `{cid,pc}`) / batch (← `{cid,m,p}`). */
export interface PostBackfill {
  t: "cpb";
  cid: string;
  /** out (request): number of posts requested */
  pc?: number;
  /** in (batch): counts */
  m?: { pc: number; pt: number };
  /** in (batch): the posts */
  p?: ChannelPost[];
}

/** `cped` (↔) channel-post edit. */
export interface PostEdit {
  t: "cped";
  cid: string;
  ts: Timestamp;
  p: string;
  edts: Timestamp;
  fc?: Callsign;
  rts?: Timestamp;
  rfc?: Callsign;
}

/** `cpedb` (←) channel-post edit batch. */
export interface PostEditBatch {
  t: "cpedb";
  cid: string;
  ed: Array<{ ts: Timestamp; p: string; edts: Timestamp }>;
}

/** `cpr` (←) channel-post delivery receipt. */
export interface PostReceipt {
  t: "cpr";
  ts: Timestamp;
  dts?: Timestamp;
}

/** `cpem` (↔) channel-post emoji. `a` = 1 add / 0 remove. */
export interface PostEmoji {
  t: "cpem";
  a: 0 | 1;
  ts: Timestamp;
  cid: string;
  e: string;
  /** inbound: the reactor */
  fc?: Callsign;
}

/** `cpemb` (←) channel-post emoji batch. */
export interface PostEmojiBatch {
  t: "cpemb";
  cid: string;
  e: Array<{ ts: Timestamp; e: string; ets: Timestamp }>;
}

/** `cu` (→) channel "unpause" / catch-up request for a previously-paused channel. */
export interface ChannelCatchup {
  t: "cu";
  cid: string;
  /** last-known ts (gap-fill from here) */
  lts?: Timestamp;
  /** or a post count */
  pc?: number;
}

// ---- WhatsPic (avatars / small images) ----

/**
 * `a` WhatsPic avatar: upload (→ `{a}`), push (← `{c,a,ts}`), or pending-count
 * (← `{ac}`). The image is the base64 of a 40×40 JPEG (no chunking).
 */
export interface Avatar {
  t: "a";
  /** callsign (inbound push) */
  c?: Callsign;
  /** the image: base64 of a 40×40 JPEG */
  a?: string;
  ts?: Timestamp;
  /** pending-avatar count (inbound count form) */
  ac?: number;
}

/** `ae` (→) avatar/WhatsPic enquiry: "give me avatars newer than `lats`". */
export interface AvatarEnquiry {
  t: "ae";
  lats: Timestamp;
  /** 1 = check-only / count mode */
  co?: 0 | 1;
}

/** `ar` (←) avatar response / upload-ack. */
export interface AvatarResponse {
  t: "ar";
  [key: string]: unknown;
}

// ---- Aggregate types ----

/** Map of `t` discriminator → its message interface, for narrowing. */
export interface WpsMessageByType {
  c: ConnectOut | ConnectReply;
  k: Keepalive;
  u: UserList;
  o: OnlineList;
  uc: UserConnected;
  ud: UserDisconnected;
  ue: UserEnquiry;
  he: HamEnquiry;
  s: Stats;
  p: Pairing;
  m: DirectMessage;
  mb: DmBackfill;
  med: DmEdit;
  medb: DmEditBatch;
  mr: DmReceipt;
  mem: DmEmoji;
  memb: DmEmojiBatch;
  pch: ChannelHeaders;
  cs: ChannelSubscribe;
  cp: ChannelPost;
  cpb: PostBackfill;
  cped: PostEdit;
  cpedb: PostEditBatch;
  cpr: PostReceipt;
  cpem: PostEmoji;
  cpemb: PostEmojiBatch;
  cu: ChannelCatchup;
  a: Avatar;
  ae: AvatarEnquiry;
  ar: AvatarResponse;
}

/** The set of `t` values whose shape we model. */
export type KnownType = keyof WpsMessageByType;

/**
 * A parsed WPS message: a `t` discriminator plus arbitrary fields. The codec
 * returns this loose type; narrow it with {@link isType} or a `m.t === "…"`
 * check to one of the typed interfaces above. Unknown `t` values are valid
 * (and ignored by a conforming client, per §4).
 */
export type WpsMessage = { t: string } & Record<string, unknown>;

/** Narrow a parsed message to a known typed interface by its `t` value. */
export function isType<K extends KnownType>(
  msg: WpsMessage,
  t: K,
): msg is WpsMessageByType[K] & WpsMessage {
  return msg.t === t;
}
