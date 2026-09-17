// ---------------------------------------------------------------------------
// quiver-test-auth-unit.test.ts — token-binding regression for the Quiver
// x-test-user bypass.
//
// The QUIVER_ALLOW_TEST_AUTH=1 flag only enables test mode in the process;
// an identity is bound ONLY when the request proves possession of the shared
// harness token (vuln: unauth test-user injection). Pins:
//   - flag off (or production) → never bound, even with a valid token.
//   - flag on + valid header token → bound.
//   - flag on + missing/wrong/short token → not bound.
//   - query twin (?x-tellus-test-auth-token=) honored ONLY with
//     allowQueryToken:true (the WS-gateway browser path); HTTP routes stay
//     header-only.
//   - malformed inputs (throwing header accessor, array headers, bad URLs)
//     fail closed.
//
// Run: npx vitest run --config vitest.unit.config.ts <this-file>
// ---------------------------------------------------------------------------
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  isQuiverTestAuthBound,
  TEST_AUTH_TOKEN_QUERY_PARAM,
} from "../../../src/routes/quiver/testAuth";
import { TEST_AUTH_TOKEN_HEADER } from "../../../src/utils/testAuthGate";

const TOKEN = "quiver-unit-token-0123456789abcdef0123456789abcdef";

function expressReq(headers: Record<string, string> = {}): {
  header: (name: string) => string | undefined;
} {
  return { header: (name: string) => headers[name] };
}

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("QUIVER_ALLOW_TEST_AUTH", "1");
  vi.stubEnv("CODE_REPOS_TEST_AUTH_TOKEN", TOKEN);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("isQuiverTestAuthBound", () => {
  it("binds with flag on + valid header token", () => {
    expect(
      isQuiverTestAuthBound(
        expressReq({ [TEST_AUTH_TOKEN_HEADER]: TOKEN }),
      ),
    ).toBe(true);
  });

  it("does not bind when the flag is off, even with a valid token", () => {
    vi.stubEnv("QUIVER_ALLOW_TEST_AUTH", "0");
    expect(
      isQuiverTestAuthBound(
        expressReq({ [TEST_AUTH_TOKEN_HEADER]: TOKEN }),
      ),
    ).toBe(false);
  });

  it("does not bind in production, even with flag + valid token", () => {
    vi.stubEnv("NODE_ENV", "production");
    // The flag gate itself is production-rejecting, so the bound check
    // can never pass in production regardless of the presented token.
    expect(
      isQuiverTestAuthBound(
        expressReq({ [TEST_AUTH_TOKEN_HEADER]: TOKEN }),
      ),
    ).toBe(false);
  });

  it("does not bind with a missing token", () => {
    expect(isQuiverTestAuthBound(expressReq({}))).toBe(false);
  });

  it("does not bind with a wrong token", () => {
    expect(
      isQuiverTestAuthBound(
        expressReq({
          [TEST_AUTH_TOKEN_HEADER]: "wrong-token-wrong-token-wrong-token",
        }),
      ),
    ).toBe(false);
  });

  it("does not bind when the env token is short", () => {
    vi.stubEnv("CODE_REPOS_TEST_AUTH_TOKEN", "short");
    expect(
      isQuiverTestAuthBound(expressReq({ [TEST_AUTH_TOKEN_HEADER]: "short" })),
    ).toBe(false);
  });

  it("honors the query twin only with allowQueryToken:true", () => {
    const url = `/quiver/api/v1/collab?x-test-user=alice&${TEST_AUTH_TOKEN_QUERY_PARAM}=${TOKEN}`;
    expect(isQuiverTestAuthBound({ url })).toBe(false);
    expect(isQuiverTestAuthBound({ url }, { allowQueryToken: true })).toBe(
      true,
    );
  });

  it("rejects a wrong query token even with allowQueryToken:true", () => {
    const url = `/quiver/api/v1/collab?${TEST_AUTH_TOKEN_QUERY_PARAM}=nope-nope-nope-nope-nope-nope`;
    expect(isQuiverTestAuthBound({ url }, { allowQueryToken: true })).toBe(
      false,
    );
  });

  it("reads raw (lowercased) headers dicts like the WS upgrade request", () => {
    expect(
      isQuiverTestAuthBound({
        headers: { "x-tellus-test-auth-token": TOKEN },
      }),
    ).toBe(true);
  });

  it("fails closed on a throwing header accessor", () => {
    const req = {
      header: () => {
        throw new Error("boom");
      },
    };
    expect(isQuiverTestAuthBound(req)).toBe(false);
  });

  it("fails closed on malformed URLs", () => {
    expect(
      isQuiverTestAuthBound({ url: "http://[" }, { allowQueryToken: true }),
    ).toBe(false);
  });
});
