// ---------------------------------------------------------------------------
// testAuthGate — Phase 5 auth-gating tests.
//
// Proves:
//   • X-Tellus-Test-Principal (and siblings) are REJECTED in
//     production-like environments at every acceptance path.
//   • Accepted only where intentionally enabled (flag + dev/test env).
//   • The boot guard now covers CODE_ASSISTANT_TEST_AUTH (previously
//     unguarded).
// ---------------------------------------------------------------------------
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";

// Stub requireTellusAuth so importing the middlewares doesn't pull
// foundryDb, and so the production path is observable.
const { upstreamMock } = vi.hoisted(() => ({ upstreamMock: vi.fn() }));
vi.mock("../../../src/middleware/tellusAuth.js", () => ({
  requireTellusAuth: upstreamMock,
}));
vi.mock("../../../src/middleware/tellusAuth", () => ({
  requireTellusAuth: upstreamMock,
}));

import {
  assertNoTestAuthInProduction,
  isTestAuthBypassEnabled,
  TEST_AUTH_FLAGS,
} from "../../../src/utils/testAuthGate";
import { requireCodeReposAuth } from "../../../src/services/codeRepos/middleware/principal";
import { requireCodeAssistantAuth } from "../../../src/routes/codeAssistant";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("isTestAuthBypassEnabled", () => {
  it.each([
    ["flag + production", { FLAG_X: "1", NODE_ENV: "production" }, {}, false],
    ["flag + development", { FLAG_X: "1", NODE_ENV: "development" }, {}, true],
    ["flag + test", { FLAG_X: "1", NODE_ENV: "test" }, {}, true],
    ["flag + unset NODE_ENV (default policy)", { FLAG_X: "1" }, {}, true],
    [
      "flag + unset NODE_ENV (strict policy)",
      { FLAG_X: "1" },
      { allowUnsetNodeEnv: false },
      false,
    ],
    ["no flag + development", { NODE_ENV: "development" }, {}, false],
    ["flag=0 + test", { FLAG_X: "0", NODE_ENV: "test" }, {}, false],
  ])("%s", (_label, env, opts, expected) => {
    expect(isTestAuthBypassEnabled("FLAG_X", opts, env as NodeJS.ProcessEnv)).toBe(expected);
  });
});

describe("assertNoTestAuthInProduction (boot guard)", () => {
  it("throws naming CODE_ASSISTANT_TEST_AUTH (previously unguarded)", () => {
    expect(() =>
      assertNoTestAuthInProduction(TEST_AUTH_FLAGS, {
        NODE_ENV: "production",
        CODE_ASSISTANT_TEST_AUTH: "1",
      } as NodeJS.ProcessEnv),
    ).toThrow(/CODE_ASSISTANT_TEST_AUTH=1 is set in production/);
  });

  it("throws for every bypass flag in production", () => {
    for (const flag of TEST_AUTH_FLAGS) {
      expect(() =>
        assertNoTestAuthInProduction(TEST_AUTH_FLAGS, {
          NODE_ENV: "production",
          [flag]: "1",
        } as NodeJS.ProcessEnv),
      ).toThrow(new RegExp(`${flag}=1 is set in production`));
    }
  });

  it("passes in production with no flags, and in dev with flags", () => {
    expect(() =>
      assertNoTestAuthInProduction(TEST_AUTH_FLAGS, { NODE_ENV: "production" } as NodeJS.ProcessEnv),
    ).not.toThrow();
    expect(() =>
      assertNoTestAuthInProduction(TEST_AUTH_FLAGS, {
        NODE_ENV: "development",
        CODE_REPOS_TEST_AUTH: "1",
      } as NodeJS.ProcessEnv),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Middleware-level production rejection.
// ---------------------------------------------------------------------------

function mockReq(headers: Record<string, string>, remoteAddress = "127.0.0.1"): Request {
  return {
    header: (h: string) => headers[h],
    headers,
    ip: remoteAddress,
    socket: { remoteAddress },
  } as unknown as Request;
}

// Shared harness token for token-bound test-principal cases (also stubbed
// into process.env via vi.stubEnv in each case).
const TOKEN = "gate-lane-token-0123456789abcdef0123456789abcdef01";

function mockRes() {
  const state = { statusCode: 200, body: null as unknown };
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
  return res as unknown as Response & { state: typeof state };
}

describe("X-Tellus-Test-Principal rejected in production-like environments", () => {
  beforeEach(() => {
    // The production path delegates to requireTellusAuth; make it a
    // visible 401 so the test can assert the bypass header was ignored.
    upstreamMock.mockReturnValue(
      (req: Request, res: Response, _next: unknown) => {
        void req;
        res.status(401).json({ errorName: "AuthenticationError" });
      },
    );
  });

  it("code-repos: production + flag + header → no fabricated principal", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("CODE_REPOS_TEST_AUTH", "1");
    const req = mockReq({ "X-Tellus-Test-Principal": "attacker/tellus-superadmin" });
    const res = mockRes();
    requireCodeReposAuth()(req, res, () => undefined);
    expect(
      (req as Request & { codeReposPrincipal?: unknown }).codeReposPrincipal,
    ).toBeUndefined();
    expect(res.state.statusCode).toBe(401);
  });

  it("code-repos: development + flag + header → principal honored", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("CODE_REPOS_TEST_AUTH", "1");
    vi.stubEnv("CODE_REPOS_TEST_AUTH_TOKEN", TOKEN);
    const req = mockReq({
      "X-Tellus-Test-Principal": "alice/READER",
      "X-Tellus-Test-Auth-Token": TOKEN,
    });
    const res = mockRes();
    let nextCalled = false;
    requireCodeReposAuth()(req, res, () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(true);
    expect(
      (req as Request & { codeReposPrincipal?: { userId: string } }).codeReposPrincipal?.userId,
    ).toBe("alice");
  });

  it("code-repos: development + flag + header but NO token → no principal, 401", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("CODE_REPOS_TEST_AUTH", "1");
    vi.stubEnv("CODE_REPOS_TEST_AUTH_TOKEN", TOKEN);
    const req = mockReq({
      "X-Tellus-Test-Principal": "attacker/tellus-superadmin",
    });
    const res = mockRes();
    let nextCalled = false;
    requireCodeReposAuth()(req, res, () => {
      nextCalled = true;
    });
    // Token-bound: an untokened header must not bind an identity even on
    // loopback (port-forwarded deployments present remote callers as
    // loopback, so the token is the actual boundary).
    expect(nextCalled).toBe(false);
    expect(
      (req as Request & { codeReposPrincipal?: unknown }).codeReposPrincipal,
    ).toBeUndefined();
    expect(res.state.statusCode).toBe(401);
  });

  it("code-assistant: production + flag + header → 401, no test principal", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("CODE_ASSISTANT_TEST_AUTH", "1");
    const req = mockReq({ "X-Tellus-Test-Principal": "attacker" });
    const res = mockRes();
    requireCodeAssistantAuth()(req, res, () => undefined);
    expect(
      (req as Request & { codeAssistantPrincipal?: unknown }).codeAssistantPrincipal,
    ).toBeUndefined();
    expect(res.state.statusCode).toBe(401);
  });

  it("code-assistant: test env + flag + header → principal honored", () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("CODE_ASSISTANT_TEST_AUTH", "1");
    vi.stubEnv("CODE_REPOS_TEST_AUTH_TOKEN", TOKEN);
    const req = mockReq({
      "X-Tellus-Test-Principal": "alice",
      "X-Tellus-Test-Auth-Token": TOKEN,
    });
    const res = mockRes();
    let nextCalled = false;
    requireCodeAssistantAuth()(req, res, () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(true);
    expect(
      (req as Request & { codeAssistantPrincipal?: { userId: string } })
        .codeAssistantPrincipal?.userId,
    ).toBe("alice");
  });

  it("code-assistant: test env + flag + header but NO token → 401, no test principal", () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("CODE_ASSISTANT_TEST_AUTH", "1");
    vi.stubEnv("CODE_REPOS_TEST_AUTH_TOKEN", TOKEN);
    const req = mockReq({ "X-Tellus-Test-Principal": "attacker" });
    const res = mockRes();
    let nextCalled = false;
    requireCodeAssistantAuth()(req, res, () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(false);
    expect(
      (req as Request & { codeAssistantPrincipal?: unknown }).codeAssistantPrincipal,
    ).toBeUndefined();
    expect(res.state.statusCode).toBe(401);
  });
});
