// ---------------------------------------------------------------------------
// T-07 — responseFormatter envelope unit tests.
//
// Covers contracts:
//   C-100 sanitizeMessage strips stack frames, paths, IPs, SQL fragments.
//   C-101 formatError routes legacy codes through CANONICAL_ERROR_ALIAS
//          to the correct HTTP status (CHART_ERROR/VALIDATION_FAILED/
//          LINK_CYCLE_DETECTED → 400, NOT_FOUND → 404, SQL_ERROR → 400)
//          while preserving the caller-supplied code verbatim in the
//          response body. This pins both halves of the contract: status
//          routing canonicalised, wire body unchanged. Pre-existing e2e
//          contracts and production dashboards key on the original code,
//          so rewriting it on the fly would be a silent breaking change.
//   C-102 sendError (a) hits the canonical HTTP status for legacy codes
//          and (b) routes the message through sanitizeMessage; the
//          response code stays as the caller passed it.
//   C-103 the legacy `error.{code,message,details,timestamp}` compat shim
//          is preserved with the caller-supplied code.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi } from "vitest";
import {
  formatError,
  sanitizeMessage,
  sendError,
} from "../../../src/utils/responseFormatter";

describe("T-07 sanitizeMessage (C-100)", () => {
  it("T-07 C-100a: strips named stack frames", () => {
    const msg =
      "TypeError: x is undefined at fn (/Users/foo/src/router.ts:42:11) at Layer.handle";
    const out = sanitizeMessage(msg);
    expect(out).not.toMatch(/\bat\s+fn\s+\(/);
    // The path embedded in the frame is also stripped.
    expect(out).not.toContain("router.ts:42");
  });

  it("T-07 C-100b: strips bare frames `at path:line:col`", () => {
    const msg = "x failed at /tmp/foo/bar.js:10:3 with code 500";
    const out = sanitizeMessage(msg);
    expect(out).not.toContain("/tmp/foo/bar.js:10:3");
    expect(out).not.toContain("/tmp/foo/bar.js");
  });

  it("T-07 C-100c: replaces absolute POSIX paths with <path>", () => {
    const out = sanitizeMessage("Could not open /etc/passwd for reading.");
    expect(out).toContain("<path>");
    expect(out).not.toContain("/etc/passwd");
  });

  it("T-07 C-100d: replaces dotted-quad IPv4 with <ip>", () => {
    const out = sanitizeMessage("Connection refused: 10.0.42.1:5432");
    expect(out).toContain("<ip>");
    expect(out).not.toContain("10.0.42.1");
  });

  it("T-07 C-100e: collapses leaked SQL fragments to <sql>", () => {
    const out = sanitizeMessage(
      "duplicate key value violates unique constraint after SELECT id, name FROM secret_table WHERE 1=1",
    );
    expect(out).toContain("<sql>");
    expect(out).not.toContain("SELECT id, name");
    expect(out).not.toContain("secret_table");
  });

  it("T-07 C-100f: empty input is returned unchanged", () => {
    expect(sanitizeMessage("")).toBe("");
  });

  it("T-07 C-100g: short safe message is returned unchanged (modulo whitespace trim)", () => {
    const out = sanitizeMessage("Object type not found.");
    expect(out).toBe("Object type not found.");
  });
});

describe("T-07 formatError code preservation + status routing (C-101)", () => {
  it.each([
    ["CHART_ERROR", 400],
    ["VALIDATION_FAILED", 400],
    ["NOT_FOUND", 404],
    ["SQL_ERROR", 400],
    ["LINK_CYCLE_DETECTED", 400],
  ])(
    "T-07 C-101: legacy '%s' → status %d, errorCode preserved verbatim, no subtype mutation",
    (legacy, status) => {
      const env = formatError(legacy, "x", { hops: 5 }, "req-1");
      // Status canonicalises (the alias hop fixes 500-fallback regressions).
      expect(env.statusCode).toBe(status);
      // Wire body is the *caller-supplied* code — not rewritten.
      expect(env.errorCode).toBe(legacy);
      expect(env.error.code).toBe(legacy);
      // Caller parameters pass through unchanged — no `subtype` injection,
      // no `parameters` rewriting.
      expect(env.parameters).toEqual({ hops: 5 });
      expect(env.parameters.subtype).toBeUndefined();
    },
  );

  it("T-07 C-101a: canonical code (no alias) round-trips with status from ERROR_CODES", () => {
    const env = formatError("OBJECT_TYPE_NOT_FOUND", "missing", {}, "req-2");
    expect(env.errorCode).toBe("OBJECT_TYPE_NOT_FOUND");
    expect(env.parameters.subtype).toBeUndefined();
    expect(env.statusCode).toBe(404);
  });

  it("T-07 C-101b: unknown code falls back to HTTP 500 with code preserved", () => {
    const env = formatError("DEFINITELY_NOT_A_CODE", "x", {}, "req-3");
    expect(env.statusCode).toBe(500);
    expect(env.errorCode).toBe("DEFINITELY_NOT_A_CODE");
    expect(env.error.code).toBe("DEFINITELY_NOT_A_CODE");
  });

  it("T-07 C-101c: legacy CHART_ERROR no longer hits the 500 fallback (pre-T-07 regression)", () => {
    // Before T-07, CHART_ERROR had no entry in ERROR_CODES and the
    // status defaulted to 500. The alias map MUST cover that gap so
    // legacy throw sites land on 400.
    const env = formatError("CHART_ERROR", "boom", {}, "");
    expect(env.statusCode).toBe(400);
  });
});

describe("T-07 formatError + legacy shim (C-103)", () => {
  it("T-07 C-103: error.{code,message,details,timestamp} compat shim is present", () => {
    const env = formatError("OBJECT_NOT_FOUND", "missing", { id: "x" }, "r");
    expect(env.error.code).toBe("OBJECT_NOT_FOUND");
    expect(env.error.message).toBe("missing");
    expect(typeof env.error.timestamp).toBe("string");
    expect(env.error.details.id).toBe("x");
  });
});

describe("T-07 sendError (C-102)", () => {
  function mockRes(): {
    res: any;
    captured: { status?: number; body?: any };
  } {
    const captured: { status?: number; body?: any } = {};
    const res: any = {
      req: { correlationId: "req-T07" },
      status: vi.fn(function (this: any, code: number) {
        captured.status = code;
        return this;
      }),
      json: vi.fn(function (this: any, body: any) {
        captured.body = body;
        return this;
      }),
    };
    return { res, captured };
  }

  it("T-07 C-102a: sendError(CHART_ERROR) emits 400 + preserves errorCode + sanitized message", () => {
    const { res, captured } = mockRes();
    sendError(
      res,
      "CHART_ERROR",
      "boom at /Users/foo/bar.ts:1:1 with 192.168.0.1",
    );
    expect(captured.status).toBe(400);
    expect(captured.body.errorCode).toBe("CHART_ERROR");
    expect(captured.body.error.code).toBe("CHART_ERROR");
    expect(captured.body.parameters.subtype).toBeUndefined();
    expect(captured.body.message).not.toContain("/Users/foo");
    expect(captured.body.message).not.toContain("192.168.0.1");
    expect(captured.body.requestId).toBe("req-T07");
  });

  it("T-07 C-102b: sendError(VALIDATION_FAILED) emits 400 + preserves errorCode", () => {
    const { res, captured } = mockRes();
    sendError(res, "VALIDATION_FAILED", "x");
    expect(captured.status).toBe(400);
    expect(captured.body.errorCode).toBe("VALIDATION_FAILED");
    expect(captured.body.error.code).toBe("VALIDATION_FAILED");
  });

  it("T-07 C-102c: sendError preserves caller-supplied parameters verbatim (no rewriting)", () => {
    const { res, captured } = mockRes();
    sendError(res, "LINK_CYCLE_DETECTED", "cycle", { hops: 7 });
    expect(captured.body.errorCode).toBe("LINK_CYCLE_DETECTED");
    expect(captured.body.parameters).toEqual({ hops: 7 });
    expect(captured.body.parameters.subtype).toBeUndefined();
  });
});
