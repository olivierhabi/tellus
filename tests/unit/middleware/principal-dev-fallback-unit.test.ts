// ---------------------------------------------------------------------------
// principal-dev-fallback-unit.test.ts — refined Fix A regression.
//
// In dev mode (CODE_REPOS_TEST_AUTH=1), requireCodeReposAuth fabricates a
// principal so the local browser works without a valid token. Pins:
//   - no-header + localhost        -> cypress-admin's REAL UUID sub (addressable,
//     NOT the email that crashed the UUID cast) + tellus-superadmin dev bypass.
//   - X-Tellus-Test-Principal header -> override wins (precedence over fallback).
//   - no-header + NON-localhost     -> 401 Stemma:Unauthenticated (the gate:
//     a leaked CODE_REPOS_TEST_AUTH=1 in a remote non-prod env can't grant the
//     dev bypass to remote callers).
//
// Run: npx vitest run --config vitest.unit.config.ts <this-file>
// ---------------------------------------------------------------------------
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Request, Response } from "express";

// Stub requireTellusAuth so importing principal.ts doesn't pull foundryDb.
// The dev branch never calls upstream, so a no-op suffices.
vi.mock("../../../src/middleware/tellusAuth.js", () => ({
  requireTellusAuth: vi.fn(() => () => {}),
}));

import { requireCodeReposAuth } from "../../../src/services/codeRepos/middleware/principal";

const CYPRESS_ADMIN_SUB = "53cf9bcf-4c20-4aed-83f4-3c7e405453b4";

interface ResState {
  statusCode: number;
  body: unknown;
}

function mockReq(opts: {
  header?: Record<string, string>;
  remoteAddress?: string;
}): Request {
  const headers = opts.header ?? {};
  return {
    header: (h: string) => headers[h],
    headers,
    ip: opts.remoteAddress ?? null,
    socket: { remoteAddress: opts.remoteAddress ?? null },
  } as unknown as Request;
}

function mockRes(): Response & { state: ResState } {
  const state: ResState = { statusCode: 200, body: null };
  const res = {
    state,
    status(c: number) {
      state.statusCode = c;
      return this;
    },
    json(b: unknown) {
      state.body = b;
      return this;
    },
  };
  return res as unknown as Response & { state: ResState };
}

function principalOf(req: Request): { userId: string; roles: string[]; source: string } | undefined {
  return (req as Request & { codeReposPrincipal?: { userId: string; roles: string[]; source: string } })
    .codeReposPrincipal;
}

beforeEach(() => {
  vi.stubEnv("CODE_REPOS_TEST_AUTH", "1");
  vi.stubEnv("NODE_ENV", "test");
});

describe("requireCodeReposAuth — dev fallback principal (refined Fix A)", () => {
  it("fabricates cypress-admin's REAL UUID + superadmin for a localhost, no-header request", () => {
    const auth = requireCodeReposAuth();
    const req = mockReq({ remoteAddress: "127.0.0.1" });
    const res = mockRes();
    let nextCalled = false;
    auth(req, res, () => {
      nextCalled = true;
    });

    expect(nextCalled).toBe(true);
    const p = principalOf(req);
    expect(p).toBeDefined();
    expect(p!.userId).toBe(CYPRESS_ADMIN_SUB); // addressable UUID, NOT the email
    expect(p!.roles).toContain("tellus-superadmin"); // dev bypass
    expect(p!.source).toBe("test");
  });

  it("honors X-Tellus-Test-Principal override (precedence over the localhost fallback)", () => {
    const auth = requireCodeReposAuth();
    const req = mockReq({
      header: { "X-Tellus-Test-Principal": "some-uuid/VIEWER" },
      remoteAddress: "127.0.0.1",
    });
    auth(req, mockRes(), () => {});

    const p = principalOf(req);
    expect(p!.userId).toBe("some-uuid"); // the override, not the cypress-admin UUID
    expect(p!.roles).toEqual(["VIEWER"]);
  });

  it("401s (Stemma:Unauthenticated) for a no-header, NON-localhost request (the gate)", () => {
    const auth = requireCodeReposAuth();
    const req = mockReq({ remoteAddress: "203.0.113.10" }); // non-loopback
    const res = mockRes();
    let nextCalled = false;
    auth(req, res, () => {
      nextCalled = true;
    });

    expect(nextCalled).toBe(false); // fail-closed, not granted
    expect(res.state.statusCode).toBe(401);
    expect((res.state.body as { errorName?: string }).errorName).toBe(
      "Stemma:Unauthenticated",
    );
  });

  it("also fails-closed for IPv6 non-loopback", () => {
    const auth = requireCodeReposAuth();
    const req = mockReq({ remoteAddress: "2001:db8::1" });
    const res = mockRes();
    let nextCalled = false;
    auth(req, res, () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(false);
    expect(res.state.statusCode).toBe(401);
  });
});
