// ---------------------------------------------------------------------------
// Unit tests for Gap 8 (authz): the Compass decision logic that now gates the
// transforms build/retry/dry-run routes. Pure logic — no DB, no HTTP.
//
// The transforms router previously used authN only (requireCodeReposAuth); any
// authenticated principal could build against any repo. It now layers
// requireOperation(WRITE) on mutating endpoints + requireOperation(READ) on
// GETs. These tests pin the decision matrix that gate enforces:
//   - EDITOR/OWNER  -> WRITE ALLOW (can start/retry builds)
//   - READER-only   -> WRITE DENY  (can read but not mutate) ; READ ALLOW
//   - no roles      -> WRITE DENY  (and READ DENY)
// DENY maps to 404 (IDOR-as-404) at the middleware layer, not 403.
//
// Run: pnpm vitest run --config vitest.unit.config.ts tests/unit/code-repos/code-repository/transforms/transforms-authz-unit.test.ts
// ---------------------------------------------------------------------------
import { describe, expect, it, beforeEach } from "vitest";
import {
  authorizeOperation,
  registerCompassPolicy,
  resetCompassPolicy,
} from "../../../../../src/services/codeRepos/middleware/compass";
import type { CodeReposPrincipal } from "../../../../../src/services/codeRepos/middleware/principal";

const REPO = { rid: "ri.transform.main.repository.aaa", type: "Repository" };

function principal(roles: string[]): CodeReposPrincipal {
  return {
    userId: "u@tellus.local",
    source: "test",
    roles,
    scopes: [],
    sourceIp: "127.0.0.1",
    userAgent: "vitest",
  };
}

beforeEach(() => {
  resetCompassPolicy(); // restore DEFAULT_POLICY (OWNER/EDITOR ALLOW, else DENY)
});

describe("authorizeOperation — WRITE gate on build/retry/dry-run (Gap 8)", () => {
  it("OWNER -> WRITE ALLOW", async () => {
    expect(await authorizeOperation(principal(["OWNER"]), REPO, "WRITE")).toBe("ALLOW");
  });
  it("EDITOR -> WRITE ALLOW", async () => {
    expect(await authorizeOperation(principal(["EDITOR"]), REPO, "WRITE")).toBe("ALLOW");
  });
  it("READER-only -> WRITE DENY (a reader cannot start/retry builds)", async () => {
    expect(await authorizeOperation(principal(["READER"]), REPO, "WRITE")).toBe("DENY");
  });
  it("no roles -> WRITE DENY (an authenticated principal with no role on the repo is denied)", async () => {
    expect(await authorizeOperation(principal([]), REPO, "WRITE")).toBe("DENY");
  });
  it("READER+EDITOR -> WRITE ALLOW (EDITOR grant wins even with READER also present)", async () => {
    expect(await authorizeOperation(principal(["READER", "EDITOR"]), REPO, "WRITE")).toBe("ALLOW");
  });
});

describe("authorizeOperation — READ gate on GET /builds (Gap 8)", () => {
  it("READER-only -> READ ALLOW (a reader can read build status)", async () => {
    expect(await authorizeOperation(principal(["READER"]), REPO, "READ")).toBe("ALLOW");
  });
  it("no roles -> READ DENY", async () => {
    expect(await authorizeOperation(principal([]), REPO, "READ")).toBe("DENY");
  });
  it("EDITOR -> READ ALLOW", async () => {
    expect(await authorizeOperation(principal(["EDITOR"]), REPO, "READ")).toBe("ALLOW");
  });
});

describe("authorizeOperation — a registered DENY policy overrides roles (the hook a real Compass client would use)", () => {
  it("an EDITOR is DENIED when an explicit DENY policy is registered (e.g. repo suspended)", async () => {
    registerCompassPolicy(() => "DENY");
    expect(await authorizeOperation(principal(["EDITOR", "OWNER"]), REPO, "WRITE")).toBe("DENY");
  });
  it("a registered ALLOW policy admits even a no-role principal", async () => {
    registerCompassPolicy(() => "ALLOW");
    expect(await authorizeOperation(principal([]), REPO, "WRITE")).toBe("ALLOW");
  });
});
