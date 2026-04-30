// ---------------------------------------------------------------------------
// T-07 — responseFormatter envelope unit tests.
//
// Covers contracts:
//   C-100 sanitizeMessage strips stack frames, paths, IPs, SQL fragments.
//   C-101 formatError canonicalises legacy codes
//          (CHART_ERROR, VALIDATION_FAILED, NOT_FOUND, SQL_ERROR,
//           LINK_CYCLE_DETECTED) and preserves the original via
//          parameters.subtype.
//   C-102 sendError (a) hits the canonical HTTP status for the canonical
//          code and (b) routes the message through sanitizeMessage.
//   C-103 the legacy `error.{code,message,details,timestamp}` compat shim
//          is preserved.
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

describe("T-07 formatError canonicalisation (C-101)", () => {
  it.each([
    ["CHART_ERROR", "VALIDATION_ERROR", 400, "chart_error"],
    ["VALIDATION_FAILED", "VALIDATION_ERROR", 400, "validation_failed"],
    ["NOT_FOUND", "OBJECT_NOT_FOUND", 404, "not_found"],
    ["SQL_ERROR", "SQL_EXECUTION_ERROR", 400, "sql_error"],
    ["LINK_CYCLE_DETECTED", "VALIDATION_ERROR", 400, "link_cycle_detected"],
  ])(
    "T-07 C-101: legacy '%s' → canonical '%s' with status %d and parameters.subtype='%s'",
    (legacy, canonical, status, subtype) => {
      const env = formatError(legacy, "x", { hops: 5 }, "req-1");
      expect(env.errorCode).toBe(canonical);
      expect(env.statusCode).toBe(status);
      expect(env.parameters.subtype).toBe(subtype);
      // Legacy compat field carries the canonical code, not the original
      // (so consumers reading `error.code` get the unified vocabulary).
      expect(env.error.code).toBe(canonical);
      // Pre-existing parameters are preserved alongside the subtype tag.
      expect(env.parameters.hops).toBe(5);
    },
  );

  it("T-07 C-101a: canonical code (no alias) round-trips unchanged with no subtype", () => {
    const env = formatError("OBJECT_TYPE_NOT_FOUND", "missing", {}, "req-2");
    expect(env.errorCode).toBe("OBJECT_TYPE_NOT_FOUND");
    expect(env.parameters.subtype).toBeUndefined();
    expect(env.statusCode).toBe(404);
  });

  it("T-07 C-101b: unknown code falls back to HTTP 500", () => {
    const env = formatError("DEFINITELY_NOT_A_CODE", "x", {}, "req-3");
    expect(env.statusCode).toBe(500);
    expect(env.errorCode).toBe("DEFINITELY_NOT_A_CODE");
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

  it("T-07 C-102a: sendError(CHART_ERROR) emits 400 + canonical body + sanitized message", () => {
    const { res, captured } = mockRes();
    sendError(
      res,
      "CHART_ERROR",
      "boom at /Users/foo/bar.ts:1:1 with 192.168.0.1",
    );
    expect(captured.status).toBe(400);
    expect(captured.body.errorCode).toBe("VALIDATION_ERROR");
    expect(captured.body.parameters.subtype).toBe("chart_error");
    expect(captured.body.message).not.toContain("/Users/foo");
    expect(captured.body.message).not.toContain("192.168.0.1");
    expect(captured.body.requestId).toBe("req-T07");
  });

  it("T-07 C-102b: sendError(VALIDATION_FAILED) emits 400 + canonical errorCode", () => {
    const { res, captured } = mockRes();
    sendError(res, "VALIDATION_FAILED", "x");
    expect(captured.status).toBe(400);
    expect(captured.body.errorCode).toBe("VALIDATION_ERROR");
  });

  it("T-07 C-102c: sendError preserves caller-supplied parameters alongside subtype", () => {
    const { res, captured } = mockRes();
    sendError(res, "LINK_CYCLE_DETECTED", "cycle", { hops: 7 });
    expect(captured.body.parameters.subtype).toBe("link_cycle_detected");
    expect(captured.body.parameters.hops).toBe(7);
  });
});
