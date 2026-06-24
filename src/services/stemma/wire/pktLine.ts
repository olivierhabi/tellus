// ---------------------------------------------------------------------------
// B1 — Stemma smart-HTTP pkt-line codec.
//
// pkt-line is the framing format used by Git's smart-HTTP transport.
// Every pkt-line is `<4-hex-length><payload>`, where the length includes
// the 4 length bytes themselves. Three special markers exist:
//
//   "0000" — flush packet (end of stream, separator between sections)
//   "0001" — delim packet (separator within a section, v2 protocol)
//   "0002" — response-end packet (end of stateless response, v2 protocol)
//
// Maximum payload length is 65516 bytes (=> total line length 65520, the
// largest 4-hex value 0xfff0 - 4). Payloads exceeding this MUST be split.
//
// Spec contracts:
//   B1-C-05  pkt-line framing — encode + decode round-trip; reject
//            malformed lengths; honour 0000/0001/0002 sentinels.
//
// This module is pure logic — no I/O, no Express, no Postgres. It is
// the foundation of the smart-HTTP advertise + receive-pack handlers.
// ---------------------------------------------------------------------------

import { Buffer } from "node:buffer";

export const PKT_FLUSH = "0000";
export const PKT_DELIM = "0001";
export const PKT_RESPONSE_END = "0002";

/** Maximum bytes in a single pkt-line payload (excluding the 4-hex length prefix). */
export const PKT_MAX_PAYLOAD = 65516;

/** Total maximum pkt-line length (4-hex prefix + payload). */
export const PKT_MAX_LINE = 65520;

/** Discriminated union of the three sentinel pkt-line kinds + a data line. */
export type PktKind = "data" | "flush" | "delim" | "response-end";

export interface PktLine {
  readonly kind: PktKind;
  /** Raw payload bytes for data lines. Empty for sentinel kinds. */
  readonly payload: Buffer;
}

/**
 * Encode a single data pkt-line. Throws if payload exceeds PKT_MAX_PAYLOAD.
 *
 * Note: Git's pkt-line payload may include a trailing newline by
 * convention but it's not required by the framing — this encoder
 * preserves whatever bytes the caller provides.
 */
export function encodeDataLine(payload: Buffer | string): Buffer {
  const buf = typeof payload === "string" ? Buffer.from(payload, "utf8") : payload;
  if (buf.length > PKT_MAX_PAYLOAD) {
    throw new Error(
      `pkt-line payload exceeds max ${PKT_MAX_PAYLOAD} bytes: ${buf.length}`,
    );
  }
  const total = buf.length + 4;
  const lenHex = total.toString(16).padStart(4, "0");
  return Buffer.concat([Buffer.from(lenHex, "ascii"), buf]);
}

/** Encode a sentinel pkt-line by kind. */
export function encodeSentinel(kind: Exclude<PktKind, "data">): Buffer {
  switch (kind) {
    case "flush":
      return Buffer.from(PKT_FLUSH, "ascii");
    case "delim":
      return Buffer.from(PKT_DELIM, "ascii");
    case "response-end":
      return Buffer.from(PKT_RESPONSE_END, "ascii");
  }
}

/** Encode a sequence of pkt-lines (data + sentinels) into a single buffer. */
export function encodeStream(lines: readonly (Buffer | string | PktLine)[]): Buffer {
  const chunks: Buffer[] = [];
  for (const line of lines) {
    if (Buffer.isBuffer(line) || typeof line === "string") {
      chunks.push(encodeDataLine(line));
      continue;
    }
    if (line.kind === "data") {
      chunks.push(encodeDataLine(line.payload));
    } else {
      chunks.push(encodeSentinel(line.kind));
    }
  }
  return Buffer.concat(chunks);
}

export class PktLineDecodeError extends Error {
  readonly code:
    | "MALFORMED_LENGTH"
    | "TRUNCATED_LINE"
    | "INVALID_HEX"
    | "OVERSIZED_LINE";
  constructor(
    code: PktLineDecodeError["code"],
    message: string,
  ) {
    super(message);
    this.name = "PktLineDecodeError";
    this.code = code;
  }
}

/**
 * Decode a single pkt-line at offset `start`. Returns the decoded line
 * and the offset of the next line. Throws PktLineDecodeError on:
 *   - fewer than 4 bytes available (TRUNCATED_LINE)
 *   - non-hex length prefix (INVALID_HEX)
 *   - length 0003 (reserved; per RFC, never valid)
 *   - declared length larger than buffer (TRUNCATED_LINE)
 *   - declared length > PKT_MAX_LINE (OVERSIZED_LINE)
 */
export function decodeOne(
  buf: Buffer,
  start: number,
): { line: PktLine; next: number } {
  if (start + 4 > buf.length) {
    throw new PktLineDecodeError(
      "TRUNCATED_LINE",
      `truncated length prefix at offset ${start}`,
    );
  }
  const lenHex = buf.subarray(start, start + 4).toString("ascii");
  if (!/^[0-9a-fA-F]{4}$/.test(lenHex)) {
    throw new PktLineDecodeError(
      "INVALID_HEX",
      `invalid pkt-line length ${JSON.stringify(lenHex)} at offset ${start}`,
    );
  }
  const len = parseInt(lenHex, 16);
  if (len === 0) {
    return { line: { kind: "flush", payload: Buffer.alloc(0) }, next: start + 4 };
  }
  if (len === 1) {
    return { line: { kind: "delim", payload: Buffer.alloc(0) }, next: start + 4 };
  }
  if (len === 2) {
    return {
      line: { kind: "response-end", payload: Buffer.alloc(0) },
      next: start + 4,
    };
  }
  if (len === 3) {
    throw new PktLineDecodeError(
      "MALFORMED_LENGTH",
      `pkt-line length 0003 is reserved and not a valid frame`,
    );
  }
  if (len > PKT_MAX_LINE) {
    throw new PktLineDecodeError(
      "OVERSIZED_LINE",
      `pkt-line length ${len} exceeds max ${PKT_MAX_LINE}`,
    );
  }
  if (start + len > buf.length) {
    throw new PktLineDecodeError(
      "TRUNCATED_LINE",
      `pkt-line declared length ${len} but only ${buf.length - start} bytes available`,
    );
  }
  return {
    line: {
      kind: "data",
      payload: buf.subarray(start + 4, start + len),
    },
    next: start + len,
  };
}

/**
 * Decode a buffer up to (and including) the first flush packet. Returns
 * the lines and the offset immediately after the flush. Used by handlers
 * that need to read a section (e.g., capability + ref-update commands)
 * without consuming the whole body.
 */
export function decodeUntilFlush(
  buf: Buffer,
  start: number,
): { lines: PktLine[]; next: number } {
  const lines: PktLine[] = [];
  let cur = start;
  while (cur < buf.length) {
    const { line, next } = decodeOne(buf, cur);
    lines.push(line);
    cur = next;
    if (line.kind === "flush") return { lines, next: cur };
  }
  throw new PktLineDecodeError(
    "TRUNCATED_LINE",
    "buffer ended without flush packet",
  );
}

/**
 * Decode every pkt-line in a buffer. Throws on any malformed framing.
 * Stops at the end of the buffer; does NOT require a trailing flush.
 */
export function decodeAll(buf: Buffer): PktLine[] {
  const lines: PktLine[] = [];
  let cur = 0;
  while (cur < buf.length) {
    const { line, next } = decodeOne(buf, cur);
    lines.push(line);
    cur = next;
  }
  return lines;
}

/**
 * Build a smart-HTTP service-advertisement preamble:
 *
 *   001e# service=git-upload-pack\n
 *   0000
 *
 * (length 0x001e = 30 = 4-hex + "# service=git-upload-pack\n" payload of 26).
 * The trailing flush separates the preamble from the ref-list section.
 */
export function encodeServiceAdvertisement(service: string): Buffer {
  // Trailing newline is required by the protocol.
  const payload = `# service=${service}\n`;
  return Buffer.concat([encodeDataLine(payload), encodeSentinel("flush")]);
}
