// ---------------------------------------------------------------------------
// B1 — receive-pack ref-update command parser unit tests.
//
// Covers:
//   B1-C-04 (parser half) — parse + classify + capabilities + packfile
//                            offset; reject malformed framing.
//
// Decision tag: D-2026-05-01-006.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import { Buffer } from "node:buffer";
import {
  encodeDataLine,
  encodeStream,
  encodeSentinel,
} from "../../../../../src/services/stemma/wire/pktLine";
import {
  parseReceivePackRequest,
  parseFirstCommand,
  buildCommandPayload,
  RefUpdateParseError,
  RECEIVE_PACK_ZERO_SHA,
} from "../../../../../src/services/stemma/wire/refUpdateCommand";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const SHA_C = "c".repeat(40);
const ZERO = RECEIVE_PACK_ZERO_SHA;

function build(
  cmds: { oldSha: string; newSha: string; refName: string; capabilities?: readonly string[] }[],
  packBody: Buffer = Buffer.alloc(0),
): Buffer {
  const lines = cmds.map((c) => buildCommandPayload(c));
  const stream = encodeStream([...lines, { kind: "flush", payload: Buffer.alloc(0) }]);
  return Buffer.concat([stream, packBody]);
}

describe("buildCommandPayload + parseFirstCommand round-trip", () => {
  it("first command with capabilities — round-trips", () => {
    const payload = buildCommandPayload({
      oldSha: ZERO,
      newSha: SHA_B,
      refName: "refs/heads/main",
      capabilities: ["report-status", "side-band-64k", "agent=git/2.39.0"],
    });
    const wire = encodeDataLine(payload);
    const { command, capabilities } = parseFirstCommand(wire);
    expect(command.kind).toBe("create");
    expect(command.oldSha).toBe(ZERO);
    expect(command.newSha).toBe(SHA_B);
    expect(command.refName).toBe("refs/heads/main");
    expect(capabilities).toEqual(["report-status", "side-band-64k", "agent=git/2.39.0"]);
  });

  it("subsequent command without capabilities — round-trips", () => {
    const payload = buildCommandPayload({
      oldSha: SHA_A,
      newSha: SHA_B,
      refName: "refs/tags/v1.0.0",
    });
    const wire = encodeDataLine(payload);
    const { command, capabilities } = parseFirstCommand(wire);
    expect(command.kind).toBe("update");
    expect(capabilities).toEqual([]);
  });

  it("delete command (zero new-sha) classifies as delete", () => {
    const payload = buildCommandPayload({
      oldSha: SHA_A,
      newSha: ZERO,
      refName: "refs/heads/feature/abandoned",
    });
    const wire = encodeDataLine(payload);
    const { command } = parseFirstCommand(wire);
    expect(command.kind).toBe("delete");
  });

  it("create command (zero old-sha) classifies as create", () => {
    const payload = buildCommandPayload({
      oldSha: ZERO,
      newSha: SHA_A,
      refName: "refs/heads/new-branch",
    });
    const wire = encodeDataLine(payload);
    const { command } = parseFirstCommand(wire);
    expect(command.kind).toBe("create");
  });

  it("rejects zero-to-zero command", () => {
    const payload = buildCommandPayload({
      oldSha: ZERO,
      newSha: ZERO,
      refName: "refs/heads/zombie",
    });
    const wire = encodeDataLine(payload);
    expect(() => parseFirstCommand(wire)).toThrow(/zero old-sha and zero new-sha/);
  });

  it("rejects malformed SHA", () => {
    const payload = "deadbeef 0000000000000000000000000000000000000000 refs/heads/x\n";
    const wire = encodeDataLine(payload);
    expect(() => parseFirstCommand(wire)).toThrow(/bad old-sha/);
  });

  it("rejects malformed ref-name (space inside)", () => {
    const payload = `${SHA_A} ${SHA_B} refs/heads/with space\n`;
    const wire = encodeDataLine(payload);
    // 4 fields after split — "with" and "space" — caught at field-count level
    expect(() => parseFirstCommand(wire)).toThrow(/expected 3 fields/);
  });

  it("rejects malformed ref-name (forbidden character)", () => {
    const payload = `${SHA_A} ${SHA_B} refs/heads/no$dollar\n`;
    const wire = encodeDataLine(payload);
    expect(() => parseFirstCommand(wire)).toThrow(/bad ref-name/);
  });

  it("tolerates absent trailing LF", () => {
    const payload = `${SHA_A} ${SHA_B} refs/heads/x`;
    const wire = encodeDataLine(payload);
    const { command } = parseFirstCommand(wire);
    expect(command.refName).toBe("refs/heads/x");
  });
});

describe("parseReceivePackRequest", () => {
  it("parses a single command + flush + empty packfile", () => {
    const body = build([
      { oldSha: ZERO, newSha: SHA_A, refName: "refs/heads/main", capabilities: ["report-status"] },
    ]);
    const parsed = parseReceivePackRequest(body);
    expect(parsed.commands).toHaveLength(1);
    expect(parsed.commands[0].kind).toBe("create");
    expect(parsed.capabilities).toEqual(["report-status"]);
    expect(parsed.packfileBody.length).toBe(0);
  });

  it("parses multiple commands with capabilities only on the first", () => {
    const body = build([
      { oldSha: ZERO, newSha: SHA_A, refName: "refs/heads/main", capabilities: ["report-status", "ofs-delta"] },
      { oldSha: SHA_B, newSha: SHA_C, refName: "refs/heads/dev" },
      { oldSha: SHA_C, newSha: ZERO, refName: "refs/heads/old" },
    ]);
    const parsed = parseReceivePackRequest(body);
    expect(parsed.commands).toHaveLength(3);
    expect(parsed.commands.map((c) => c.kind)).toEqual(["create", "update", "delete"]);
    expect(parsed.commands.map((c) => c.refName)).toEqual([
      "refs/heads/main",
      "refs/heads/dev",
      "refs/heads/old",
    ]);
    expect(parsed.capabilities).toEqual(["report-status", "ofs-delta"]);
  });

  it("captures the packfile body bytes after the flush", () => {
    const packBody = Buffer.from("PACK\x00\x00\x00\x02\x00\x00\x00\x00", "binary");
    const body = build(
      [{ oldSha: ZERO, newSha: SHA_A, refName: "refs/heads/main" }],
      packBody,
    );
    const parsed = parseReceivePackRequest(body);
    expect(parsed.packfileBody.equals(packBody)).toBe(true);
    // packfileOffset = bytes consumed by command + flush
    expect(parsed.packfileBody.length).toBe(packBody.length);
  });

  it("rejects empty body", () => {
    expect(() => parseReceivePackRequest(Buffer.alloc(0))).toThrow(
      /request body is empty/,
    );
  });

  it("rejects body with only flush (no commands)", () => {
    const body = encodeSentinel("flush");
    expect(() => parseReceivePackRequest(body)).toThrow(
      /no command pkt-lines/,
    );
  });

  it("rejects truncated framing (missing flush)", () => {
    const body = encodeDataLine(
      `${ZERO} ${SHA_A} refs/heads/main\n`,
    );
    // No trailing flush, no packfile.
    expect(() => parseReceivePackRequest(body)).toThrow(/without flush/);
  });

  it("attaches RefUpdateParseError code for malformed-sha", () => {
    const body = build([
      // Build a payload manually to bypass the zero-sha-aware classifier.
      {
        oldSha: "ZZZZ" + "a".repeat(36),
        newSha: SHA_A,
        refName: "refs/heads/main",
      },
    ]);
    try {
      parseReceivePackRequest(body);
      throw new Error("did not throw");
    } catch (err) {
      expect(err).toBeInstanceOf(RefUpdateParseError);
      expect((err as RefUpdateParseError).code).toBe("INVALID_SHA");
    }
  });
});
