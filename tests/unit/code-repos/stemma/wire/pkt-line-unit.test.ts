// ---------------------------------------------------------------------------
// B1 — pkt-line codec unit tests.
//
// Covers:
//   B1-C-05  pkt-line framing — encode + decode round-trip; reject
//            malformed lengths; honour 0000/0001/0002 sentinels.
//
// Decision tag: D-2026-05-01-006 (smart-HTTP engine choice).
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import { Buffer } from "node:buffer";
import {
  PKT_FLUSH,
  PKT_DELIM,
  PKT_RESPONSE_END,
  PKT_MAX_PAYLOAD,
  encodeDataLine,
  encodeSentinel,
  encodeStream,
  encodeServiceAdvertisement,
  decodeOne,
  decodeUntilFlush,
  decodeAll,
  PktLineDecodeError,
} from "../../../../../src/services/stemma/wire/pktLine";

describe("pkt-line codec — encode", () => {
  it("encodes empty payload as 0004 (B1-C-05)", () => {
    expect(encodeDataLine("").toString("ascii")).toBe("0004");
  });

  it("encodes a 4-byte payload as 0008<payload>", () => {
    expect(encodeDataLine("abcd").toString("ascii")).toBe("0008abcd");
  });

  it("encodes 'hello' as 0009hello (length=9 = 4+5)", () => {
    expect(encodeDataLine("hello").toString("ascii")).toBe("0009hello");
  });

  it("encodes a 256-byte payload with the correct hex length", () => {
    const payload = "x".repeat(256);
    const out = encodeDataLine(payload).toString("ascii");
    // 256 + 4 = 260 = 0x0104
    expect(out.slice(0, 4)).toBe("0104");
    expect(out.slice(4)).toBe(payload);
  });

  it("encodes UTF-8 multibyte payloads using byte length, not char length", () => {
    const payload = "日本語"; // 9 bytes UTF-8, 3 chars
    const out = encodeDataLine(payload);
    expect(out.subarray(0, 4).toString("ascii")).toBe("000d"); // 13 = 4 + 9
    expect(out.subarray(4).toString("utf8")).toBe(payload);
  });

  it("rejects payloads larger than PKT_MAX_PAYLOAD", () => {
    const tooBig = Buffer.alloc(PKT_MAX_PAYLOAD + 1, 0x61);
    expect(() => encodeDataLine(tooBig)).toThrow(/exceeds max/);
  });

  it("encodes the maximum payload length as ffe4...", () => {
    const max = Buffer.alloc(PKT_MAX_PAYLOAD, 0x61);
    const out = encodeDataLine(max);
    // 65520 = 0xfff0
    expect(out.subarray(0, 4).toString("ascii")).toBe("fff0");
    expect(out.length).toBe(65520);
  });

  it("encodeSentinel('flush') = '0000'", () => {
    expect(encodeSentinel("flush").toString("ascii")).toBe(PKT_FLUSH);
  });

  it("encodeSentinel('delim') = '0001'", () => {
    expect(encodeSentinel("delim").toString("ascii")).toBe(PKT_DELIM);
  });

  it("encodeSentinel('response-end') = '0002'", () => {
    expect(encodeSentinel("response-end").toString("ascii")).toBe(PKT_RESPONSE_END);
  });

  it("encodeStream concatenates lines and sentinels in order", () => {
    const out = encodeStream([
      "abc",
      { kind: "delim", payload: Buffer.alloc(0) },
      "def",
      { kind: "flush", payload: Buffer.alloc(0) },
    ]).toString("ascii");
    expect(out).toBe("0007abc0001" + "0007def" + "0000");
  });

  it("encodeServiceAdvertisement formats per smart-HTTP spec", () => {
    // payload: "# service=git-upload-pack\n" — 26 bytes; total 30 = 0x001e
    const out = encodeServiceAdvertisement("git-upload-pack").toString("ascii");
    expect(out).toBe("001e# service=git-upload-pack\n0000");
  });
});

describe("pkt-line codec — decode", () => {
  it("decodes a single data line at offset 0", () => {
    const buf = Buffer.from("0009hello", "ascii");
    const { line, next } = decodeOne(buf, 0);
    expect(line.kind).toBe("data");
    expect(line.payload.toString("ascii")).toBe("hello");
    expect(next).toBe(9);
  });

  it("decodes the flush packet 0000", () => {
    const buf = Buffer.from("0000", "ascii");
    const { line, next } = decodeOne(buf, 0);
    expect(line.kind).toBe("flush");
    expect(line.payload.length).toBe(0);
    expect(next).toBe(4);
  });

  it("decodes the delim packet 0001", () => {
    const buf = Buffer.from("0001", "ascii");
    const { line } = decodeOne(buf, 0);
    expect(line.kind).toBe("delim");
  });

  it("decodes the response-end packet 0002", () => {
    const buf = Buffer.from("0002", "ascii");
    const { line } = decodeOne(buf, 0);
    expect(line.kind).toBe("response-end");
  });

  it("rejects length 0003 as reserved", () => {
    const buf = Buffer.from("0003", "ascii");
    expect(() => decodeOne(buf, 0)).toThrow(PktLineDecodeError);
    try {
      decodeOne(buf, 0);
    } catch (err) {
      expect((err as PktLineDecodeError).code).toBe("MALFORMED_LENGTH");
    }
  });

  it("rejects non-hex length prefix", () => {
    const buf = Buffer.from("xxxxabcdef", "ascii");
    expect(() => decodeOne(buf, 0)).toThrow(/invalid pkt-line length/);
    try {
      decodeOne(buf, 0);
    } catch (err) {
      expect((err as PktLineDecodeError).code).toBe("INVALID_HEX");
    }
  });

  it("rejects truncated length prefix at end of buffer", () => {
    const buf = Buffer.from("abc", "ascii");
    expect(() => decodeOne(buf, 0)).toThrow(/truncated length prefix/);
  });

  it("rejects when declared length exceeds buffer", () => {
    const buf = Buffer.from("0010ab", "ascii"); // claims 16 bytes total, only 6 available
    expect(() => decodeOne(buf, 0)).toThrow(/declared length 16/);
  });

  it("decodeAll round-trips through encodeStream", () => {
    const wire = encodeStream([
      "first",
      "second",
      { kind: "flush", payload: Buffer.alloc(0) },
      "after-flush",
    ]);
    const lines = decodeAll(wire);
    expect(lines).toHaveLength(4);
    expect(lines[0].kind).toBe("data");
    expect(lines[0].payload.toString("ascii")).toBe("first");
    expect(lines[1].kind).toBe("data");
    expect(lines[1].payload.toString("ascii")).toBe("second");
    expect(lines[2].kind).toBe("flush");
    expect(lines[3].kind).toBe("data");
    expect(lines[3].payload.toString("ascii")).toBe("after-flush");
  });

  it("decodeUntilFlush stops at the first flush", () => {
    const wire = encodeStream([
      "preamble",
      { kind: "flush", payload: Buffer.alloc(0) },
      "after-flush",
    ]);
    const { lines, next } = decodeUntilFlush(wire, 0);
    expect(lines).toHaveLength(2);
    expect(lines[0].payload.toString("ascii")).toBe("preamble");
    expect(lines[1].kind).toBe("flush");
    // next should point at the start of the post-flush region
    expect(wire.subarray(next).toString("ascii")).toBe(
      Buffer.from("000fafter-flush", "ascii").toString("ascii"),
    );
  });

  it("decodeUntilFlush throws when buffer ends without flush", () => {
    const wire = encodeStream(["only-data"]);
    expect(() => decodeUntilFlush(wire, 0)).toThrow(/without flush/);
  });

  it("round-trips a max-sized payload", () => {
    const max = Buffer.alloc(PKT_MAX_PAYLOAD, 0x41);
    const wire = encodeDataLine(max);
    const { line, next } = decodeOne(wire, 0);
    expect(line.kind).toBe("data");
    expect(line.payload.length).toBe(PKT_MAX_PAYLOAD);
    expect(line.payload.equals(max)).toBe(true);
    expect(next).toBe(wire.length);
  });

  it("round-trips a service advertisement preamble", () => {
    const wire = encodeServiceAdvertisement("git-receive-pack");
    const lines = decodeAll(wire);
    expect(lines).toHaveLength(2);
    expect(lines[0].kind).toBe("data");
    expect(lines[0].payload.toString("ascii")).toBe(
      "# service=git-receive-pack\n",
    );
    expect(lines[1].kind).toBe("flush");
  });
});

describe("pkt-line codec — sentinel disambiguation", () => {
  it("0000 is a flush, NOT a zero-length data line", () => {
    expect(decodeOne(Buffer.from("0000", "ascii"), 0).line.kind).toBe("flush");
  });

  it("0004 is a zero-length DATA line, NOT a flush", () => {
    const out = decodeOne(Buffer.from("0004", "ascii"), 0);
    expect(out.line.kind).toBe("data");
    expect(out.line.payload.length).toBe(0);
  });

  it("0001 is a delim, NOT a 1-byte declared length", () => {
    expect(decodeOne(Buffer.from("0001", "ascii"), 0).line.kind).toBe("delim");
  });
});
