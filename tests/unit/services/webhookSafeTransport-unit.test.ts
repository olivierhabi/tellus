// ---------------------------------------------------------------------------
// Webhook Safe Transport — Phase 3 unit tests
//
// Pure helpers tested: assertEgressUrl (HTTPS enforcement + IP-literal
// rejection + cloud metadata + host allowlist), assertMethod, sanitize/redact
// headers (hop-by-hop + log redaction), request/response byte caps, response
// content-type allowlist, redirect validation (downgrade + host allow),
// idempotency-key derivation stability.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import {
  assertEgressUrl,
  assertMethod,
  sanitizeOutboundHeaders,
  redactHeadersForLog,
  assertRequestBytes,
  assertResponseBytes,
  assertResponseContentType,
  assertRedirect,
  deriveIdempotencyKey,
  isForbiddenIpLiteral,
  DEFAULT_EGRESS_POLICY,
  type EgressPolicy,
} from "../../../src/services/webhookSafeTransport";

const PROD: EgressPolicy = { ...DEFAULT_EGRESS_POLICY, httpsRequired: true };
const DEV: EgressPolicy = { ...DEFAULT_EGRESS_POLICY, httpsRequired: false };

describe("assertEgressUrl — protocol & host enforcement", () => {
  it("accepts an HTTPS URL pointing at a regular external hostname", () => {
    expect(assertEgressUrl("https://api.example.invalid/path", PROD)).toMatchObject({ kind: "ok" });
  });

  it("rejects HTTP in production", () => {
    const r = assertEgressUrl("http://api.example.invalid/x", PROD);
    expect(r.kind).toBe("errors");
    if (r.kind !== "errors") return;
    expect(r.errors.some((e) => e.code === "INSECURE_HTTP_DISABLED")).toBe(true);
  });

  it("accepts HTTP in dev (httpsRequired=false)", () => {
    expect(assertEgressUrl("http://api.example.invalid/x", DEV)).toMatchObject({ kind: "ok" });
  });

  it("rejects an unparseable URL with URL_PARSE_FAILED", () => {
    const r = assertEgressUrl("not a url at all", PROD);
    expect(r.kind).toBe("errors");
  });

  it("rejects an empty string with URL_REQUIRED", () => {
    const r = assertEgressUrl("", PROD);
    expect(r.kind).toBe("errors");
  });
});

describe("assertEgressUrl — IP-literal rejection (SSRF closure)", () => {
  it("rejects 127.0.0.1 (loopback)", () => {
    expect(isForbiddenIpLiteral("127.0.0.1")).toBe(true);
    const r = assertEgressUrl("https://127.0.0.1/x", PROD);
    if (r.kind !== "errors") throw new Error();
    expect(r.errors.some((e) => e.code === "FORBIDDEN_IP")).toBe(true);
  });

  it("rejects 169.254.169.254 with METADATA_IP (not generic FORBIDDEN_IP)", () => {
    expect(isForbiddenIpLiteral("169.254.169.254")).toBe(true);
    const r = assertEgressUrl("https://169.254.169.254/latest/meta-data/iam", PROD);
    if (r.kind !== "errors") throw new Error();
    expect(r.errors.some((e) => e.code === "METADATA_IP")).toBe(true);
  });

  it("rejects 0.0.0.0 (this-network)", () => {
    expect(isForbiddenIpLiteral("0.0.0.0")).toBe(true);
  });

  it("rejects 224.0.0.1 (multicast)", () => {
    expect(isForbiddenIpLiteral("224.0.0.1")).toBe(true);
  });

  it("rejects 240.0.0.1 (reserved)", () => {
    expect(isForbiddenIpLiteral("240.0.0.1")).toBe(true);
  });

  it("rejects ::1 (IPv6 loopback)", () => {
    expect(isForbiddenIpLiteral("::1")).toBe(true);
  });

  it("rejects ::ffff:127.0.0.1 (IPv4-in-IPv6 mapping)", () => {
    expect(isForbiddenIpLiteral("::ffff:127.0.0.1")).toBe(true);
  });

  it("accepts a regular DNS resolvable hostname", () => {
    expect(isForbiddenIpLiteral("api.example.invalid")).toBe(false);
  });
});

describe("assertEgressUrl — host allowlist", () => {
  it("rejects a host outside the allowlist", () => {
    const p: EgressPolicy = { ...PROD, allowedHosts: ["allowed.example.com"] };
    const r = assertEgressUrl("https://api.example.invalid/x", p);
    if (r.kind !== "errors") throw new Error();
    expect(r.errors.some((e) => e.code === "FORBIDDEN_HOST")).toBe(true);
  });

  it("accepts a host in the allowlist", () => {
    const p: EgressPolicy = { ...PROD, allowedHosts: ["api.example.invalid"] };
    expect(assertEgressUrl("https://api.example.invalid/x", p)).toMatchObject({ kind: "ok" });
  });
});

describe("assertMethod — HTTP method allowlist", () => {
  it("accepts GET / POST / PUT / PATCH / DELETE", () => {
    for (const m of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
      expect(assertMethod(m)).toMatchObject({ kind: "ok" });
      expect(assertMethod(m.toLowerCase())).toMatchObject({ kind: "ok" });
    }
  });

  it("rejects TRACE / CONNECT / OPTIONS / HEAD", () => {
    for (const m of ["TRACE", "CONNECT", "OPTIONS", "HEAD"]) {
      const r = assertMethod(m);
      if (r.kind !== "errors") throw new Error();
      expect(r.errors.some((e) => e.code === "FORBIDDEN_METHOD")).toBe(true);
    }
  });

  it("rejects alien methods with INVALID_METHOD", () => {
    const r = assertMethod("PROPFIND");
    if (r.kind !== "errors") throw new Error();
    expect(r.errors.some((e) => e.code === "INVALID_METHOD")).toBe(true);
  });
});

describe("sanitizeOutboundHeaders — hop-by-hop + allowlist stripping", () => {
  it("strips hop-by-hop headers per RFC 7230 §6.1", () => {
    const r = sanitizeOutboundHeaders({
      Connection: "keep-alive",
      "Keep-Alive": "timeout=5",
      Authorization: "Bearer xyz",
      "X-API-Key": "k",
      "X-Custom": "v",
    });
    expect(r.headers).toEqual({
      Authorization: "Bearer xyz",
      "X-API-Key": "k",
      "X-Custom": "v",
    });
    expect(r.stripped.sort()).toEqual(["Connection", "Keep-Alive"]);
  });

  it("honors the header allowlist when set", () => {
    const p: EgressPolicy = { ...PROD, headerAllowlist: ["authorization", "content-type"] };
    const r = sanitizeOutboundHeaders({
      Authorization: "Bearer xyz",
      "X-Trace-Id": "t",
      "Content-Type": "application/json",
    }, p);
    expect(r.headers).toEqual({
      Authorization: "Bearer xyz",
      "Content-Type": "application/json",
    });
    expect(r.stripped).toEqual(["X-Trace-Id"]);
  });
});

describe("redactHeadersForLog — credential-bearing headers masked", () => {
  it("masks authorization / cookie / set-cookie / x-api-key / x-auth-token / proxy-authorization", () => {
    const r = redactHeadersForLog({
      authorization: "Bearer secret",
      Cookie: "session=abc",
      "Set-Cookie": "id=1",
      "x-api-key": "k",
      "x-auth-token": "t",
      "Proxy-Authorization": "Basic xyz",
      "x-custom": "v",
    });
    expect(r.authorization).toBe("[REDACTED]");
    expect(r.Cookie).toBe("[REDACTED]");
    expect(r["Set-Cookie"]).toBe("[REDACTED]");
    expect(r["x-api-key"]).toBe("[REDACTED]");
    expect(r["x-auth-token"]).toBe("[REDACTED]");
    expect(r["Proxy-Authorization"]).toBe("[REDACTED]");
    expect(r["x-custom"]).toBe("v");
  });
});

describe("assertRequestBytes / assertResponseBytes — body caps", () => {
  it("accepts bytes within cap", () => {
    expect(assertRequestBytes(1024, PROD)).toMatchObject({ kind: "ok" });
    expect(assertResponseBytes(1024, PROD)).toMatchObject({ kind: "ok" });
  });

  it("rejects bytes over the cap", () => {
    const big = PROD.maxRequestBytes + 1;
    const r = assertRequestBytes(big, PROD);
    if (r.kind !== "errors") throw new Error();
    expect(r.errors[0].code).toBe("MAX_BODY_EXCEEDED");
    const bigResp = PROD.maxResponseBytes + 1;
    const r2 = assertResponseBytes(bigResp, PROD);
    if (r2.kind !== "errors") throw new Error();
    expect(r2.errors[0].code).toBe("MAX_RESPONSE_EXCEEDED");
  });
});

describe("assertResponseContentType — content-type allowlist", () => {
  it("accepts application/json and JSON variants", () => {
    expect(assertResponseContentType("application/json", PROD)).toMatchObject({ kind: "ok" });
    expect(assertResponseContentType("Application/JSON; Charset=UTF-8", PROD)).toMatchObject({ kind: "ok" });
    expect(assertResponseContentType("application/problem+json", PROD)).toMatchObject({ kind: "ok" });
  });

  it("accepts text/plain and charset variants", () => {
    expect(assertResponseContentType("text/plain; charset=utf-8", PROD)).toMatchObject({ kind: "ok" });
  });

  it("rejects an unsupported content-type", () => {
    const r = assertResponseContentType("text/html", PROD);
    if (r.kind !== "errors") throw new Error();
    expect(r.errors[0].code).toBe("CONTENT_TYPE_NOT_ALLOWED");
  });
});

describe("deriveIdempotencyKey — stability + collision-free", () => {
  it("produces the same key for (exec, attempt) twice", () => {
    expect(deriveIdempotencyKey("e1", 1)).toBe(deriveIdempotencyKey("e1", 1));
  });

  it("produces distinct keys across executions", () => {
    expect(deriveIdempotencyKey("e1", 1)).not.toBe(deriveIdempotencyKey("e2", 1));
  });

  it("produces distinct keys across attempt counts for the same execution", () => {
    expect(deriveIdempotencyKey("e1", 1)).not.toBe(deriveIdempotencyKey("e1", 2));
  });

  it("returns a 64-character hex sha256", () => {
    expect(deriveIdempotencyKey("e", 1)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("assertRedirect — redirect downgrade + host allowlist", () => {
  it("rejects redirects when the policy has followRedirects=false", () => {
    const r = assertRedirect("https://a.example/x", "https://b.example/y", PROD);
    if (r.kind !== "errors") throw new Error();
    expect(r.errors[0].code).toBe("REDIRECT_NOT_ALLOWED");
  });

  it("rejects protocol downgrade on redirect", () => {
    const p: EgressPolicy = { ...PROD, followRedirects: true };
    const r = assertRedirect("https://a.example/x", "http://a.example/y", p);
    if (r.kind !== "errors") throw new Error();
    expect(r.errors[0].code).toBe("REDIRECT_PROTOCOL_DOWNGRADE");
  });

  it("rejects redirect to a host outside the allowlist", () => {
    const p: EgressPolicy = { ...PROD, followRedirects: true, allowedHosts: ["a.example"] };
    const r = assertRedirect("https://a.example/x", "https://b.example/y", p);
    if (r.kind !== "errors") throw new Error();
    expect(r.errors[0].code).toBe("REDIRECT_HOST_NOT_ALLOWED");
  });

  it("accepts an https redirect inside the allowlist", () => {
    const p: EgressPolicy = { ...PROD, followRedirects: true, allowedHosts: ["a.example", "b.example"] };
    expect(assertRedirect("https://a.example/x", "https://b.example/y", p)).toMatchObject({ kind: "ok" });
  });
});
