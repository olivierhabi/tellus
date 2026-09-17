// ---------------------------------------------------------------------------
// principal-dev-fallback-unit.test.ts — security hardening regression.
//
// In dev mode (CODE_REPOS_TEST_AUTH=1) requireCodeReposAuth no longer
// fabricates a privileged principal for no-header requests (vuln-0024/0038/
// 0042): the previous "localhost dev fallback" handed every loopback-
// appearing caller tellus-superadmin + a pre-seeded publish grant, and
// behind a proxy every remote caller satisfies loopback. Pins:
//   - no-header (localhost OR not)  -> 401 Stemma:Unauthenticated (fail closed).
//   - X-Tellus-Test-Principal header -> override wins ONLY when the request
//     proves possession of the shared harness token (X-Tellus-Test-Auth-Token
//     matching CODE_REPOS_TEST_AUTH_TOKEN, >= 32 chars, timing-safe). An
//     untokened header — or an unset/short env token — fails closed 401
//     (vuln: unauth identity/role injection on port-forwarded deployments
//     where every remote caller appears loopback).
//   - Roles honored verbatim EXCEPT `function:publish`, which is stripped
//     (vuln-0038).
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

const TOKEN = "unit-lane-token-0123456789abcdef0123456789abcdef";

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
  vi.stubEnv("CODE_REPOS_TEST_AUTH_TOKEN", TOKEN);
});

describe("requireCodeReposAuth — no-header fails closed (vuln-0024/0038/0042)", () => {
  it("401s for a localhost, no-header request (no fabricated superadmin)", () => {
    const auth = requireCodeReposAuth();
    const req = mockReq({ remoteAddress: "127.0.0.1" });
    const res = mockRes();
    let nextCalled = false;
    auth(req, res, () => {
      nextCalled = true;
    });

    expect(nextCalled).toBe(false); // fail-closed: no privileged fabrication
    expect(res.state.statusCode).toBe(401);
    expect((res.state.body as { errorName?: string }).errorName).toBe(
      "Stemma:Unauthenticated",
    );
  });

  it("honors X-Tellus-Test-Principal override (loopback + valid harness token)", () => {
    const auth = requireCodeReposAuth();
    const req = mockReq({
      header: {
        "X-Tellus-Test-Principal": "some-uuid/VIEWER",
        "X-Tellus-Test-Auth-Token": TOKEN,
      },
      remoteAddress: "127.0.0.1",
    });
    auth(req, mockRes(), () => {});

    const p = principalOf(req);
    expect(p!.userId).toBe("some-uuid");
    expect(p!.roles).toEqual(["VIEWER"]);
  });

  it("honors the documented X-Tellus-Test-Role(s) headers (canonicalized Compass roles)", () => {
    const auth = requireCodeReposAuth();
    const req = mockReq({
      header: {
        "X-Tellus-Test-Principal": "transforms-e2e",
        "X-Tellus-Test-Roles": "editor",
        "X-Tellus-Test-Auth-Token": TOKEN,
      },
      remoteAddress: "127.0.0.1",
    });
    auth(req, mockRes(), () => {});

    const p = principalOf(req);
    expect(p!.userId).toBe("transforms-e2e");
    expect(p!.roles).toEqual(["EDITOR"]);
  });

  it("merges X-Tellus-Test-Roles with embedded roles; embedded roles stay verbatim", () => {
    const auth = requireCodeReposAuth();
    const req = mockReq({
      header: {
        "X-Tellus-Test-Principal": "alice/tellus-superadmin",
        "X-Tellus-Test-Role": "Owner",
        "X-Tellus-Test-Auth-Token": TOKEN,
      },
      remoteAddress: "127.0.0.1",
    });
    auth(req, mockRes(), () => {});

    const p = principalOf(req);
    expect(p!.roles).toEqual(["tellus-superadmin", "OWNER"]);
  });

  it("strips function:publish from the embedded header roles (vuln-0038)", () => {
    const auth = requireCodeReposAuth();
    const req = mockReq({
      header: {
        "X-Tellus-Test-Principal": "attacker/function:publish,EDITOR",
        "X-Tellus-Test-Auth-Token": TOKEN,
      },
      remoteAddress: "127.0.0.1",
    });
    auth(req, mockRes(), () => {});

    const p = principalOf(req);
    expect(p!.roles).toEqual(["EDITOR"]); // function:publish stripped
  });

  it("401s (Stemma:Unauthenticated) for a no-header, NON-localhost request", () => {
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

// ---------------------------------------------------------------------------
// Token binding (vuln: unauth test-principal injection). The flag only
// enables test mode; the shared token is what authenticates the caller.
// ---------------------------------------------------------------------------
describe("requireCodeReposAuth — harness token binding fails closed", () => {
  it("401s when the principal header is presented WITHOUT the harness token", () => {
    const auth = requireCodeReposAuth();
    const req = mockReq({
      header: { "X-Tellus-Test-Principal": "attacker/tellus-superadmin" },
      remoteAddress: "127.0.0.1", // loopback — the token is the boundary
    });
    const res = mockRes();
    let nextCalled = false;
    auth(req, res, () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(false);
    expect(principalOf(req)).toBeUndefined();
    expect(res.state.statusCode).toBe(401);
  });

  it("401s when the presented token does not match the env token", () => {
    const auth = requireCodeReposAuth();
    const req = mockReq({
      header: {
        "X-Tellus-Test-Principal": "attacker/tellus-superadmin",
        "X-Tellus-Test-Auth-Token": "wrong-token-wrong-token-wrong-token",
      },
      remoteAddress: "127.0.0.1",
    });
    const res = mockRes();
    let nextCalled = false;
    auth(req, res, () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(false);
    expect(principalOf(req)).toBeUndefined();
    expect(res.state.statusCode).toBe(401);
  });

  it("401s when the env token is unset (fail closed — no bypass at all)", () => {
    vi.stubEnv("CODE_REPOS_TEST_AUTH_TOKEN", "");
    const auth = requireCodeReposAuth();
    const req = mockReq({
      header: {
        "X-Tellus-Test-Principal": "attacker/tellus-superadmin",
        "X-Tellus-Test-Auth-Token": "",
      },
      remoteAddress: "127.0.0.1",
    });
    const res = mockRes();
    let nextCalled = false;
    auth(req, res, () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(false);
    expect(res.state.statusCode).toBe(401);
  });

  it("401s when the env token is too short (< 32 chars)", () => {
    vi.stubEnv("CODE_REPOS_TEST_AUTH_TOKEN", "short-token");
    const auth = requireCodeReposAuth();
    const req = mockReq({
      header: {
        "X-Tellus-Test-Principal": "attacker/tellus-superadmin",
        "X-Tellus-Test-Auth-Token": "short-token",
      },
      remoteAddress: "127.0.0.1",
    });
    const res = mockRes();
    let nextCalled = false;
    auth(req, res, () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(false);
    expect(res.state.statusCode).toBe(401);
  });
});
