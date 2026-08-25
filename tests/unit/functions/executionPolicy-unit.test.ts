// ---------------------------------------------------------------------------
// executionPolicy-unit.test.ts — publish authorization (authorizePublish)
// + legacy contract deprecation controls.
//
// The unit lane has no Postgres: authorizePublish() is driven against a fake
// Queryable that applies the same filtering the SQL does. Env manipulation
// follows the file's historic pattern (direct process.env + restore).
// ---------------------------------------------------------------------------

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  authorizePublish,
  executionPolicy,
  isLegacyContractExecutionAllowed,
  type Queryable,
} from "../../../src/services/functions/executionPolicy";

const KEYS = [
  "FUNCTION_EXECUTION_TRUST_MODE",
  "FUNCTION_TRUSTED_AUTHOR_IDS",
  "FUNCTION_PUBLISH_ROLE",
  "FUNCTION_LEGACY_CONTRACT_DISABLED",
  "FUNCTION_LEGACY_CONTRACT_DEPRECATION_DATE",
] as const;

const saved = new Map<string, string | undefined>();
for (const key of KEYS) saved.set(key, process.env[key]);

afterEach(() => {
  for (const key of KEYS) {
    const original = saved.get(key);
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
  delete process.env.NODE_ENV;
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Policy mode (env parsing)
// ---------------------------------------------------------------------------

describe("executionPolicy trust mode", () => {
  it("defaults to trusted-authors-only when unset", () => {
    delete process.env.FUNCTION_EXECUTION_TRUST_MODE;
    expect(executionPolicy().trustMode).toBe("trusted-authors-only");
  });

  it("an unknown mode value fails closed to trusted-authors-only", () => {
    process.env.FUNCTION_EXECUTION_TRUST_MODE = "yolo";
    expect(executionPolicy().trustMode).toBe("trusted-authors-only");
  });

  it("open-development is honored outside production", () => {
    process.env.NODE_ENV = "test";
    process.env.FUNCTION_EXECUTION_TRUST_MODE = "open-development";
    expect(executionPolicy().trustMode).toBe("open-development");
  });

  it("open-development is REFUSED in production (cannot silently open)", () => {
    process.env.NODE_ENV = "production";
    process.env.FUNCTION_EXECUTION_TRUST_MODE = "open-development";
    expect(executionPolicy().trustMode).toBe("trusted-authors-only");
  });

  it("defaults the publish role, honoring FUNCTION_PUBLISH_ROLE overrides", () => {
    delete process.env.FUNCTION_PUBLISH_ROLE;
    expect(executionPolicy().publishRole).toBe("function:publish");
    process.env.FUNCTION_PUBLISH_ROLE = "custom-publisher";
    expect(executionPolicy().publishRole).toBe("custom-publisher");
  });
});

// ---------------------------------------------------------------------------
// Fake Queryable for authorizePublish
// ---------------------------------------------------------------------------

interface FakeGrant {
  readonly id: string;
  readonly subject_type: "local_user" | "keycloak_sub";
  readonly subject_id: string;
  readonly scope_type: "global" | "repository";
  readonly scope_rid: string | null;
  readonly expires_at: string | null;
  readonly revoked_at: string | null;
}

interface FakeDb extends Queryable {
  readonly audit: readonly Record<string, unknown>[];
}

function makeDb(opts: {
  grants?: FakeGrant[];
  failGrants?: boolean;
  failAudit?: boolean;
}): FakeDb {
  const grants = opts.grants ?? [];
  const audit: Record<string, unknown>[] = [];
  return {
    audit,
    async query(sql: string, params?: unknown[]) {
      if (/INSERT INTO function_publish_audit_log/.test(sql)) {
        if (opts.failAudit) throw new Error("audit relation down");
        audit.push({
          event_type: params![0],
          subject_type: params![1],
          subject_id: params![2],
          keycloak_sub: params![3],
          local_user_id: params![4],
          repository_rid: params![5],
          release_tag: params![6],
          decision_source: params![7],
          grant_id: params![8],
        });
        return { rows: [], rowCount: 1, command: "", oid: 0, fields: [] };
      }
      if (/FROM function_publish_grants/.test(sql)) {
        if (opts.failGrants) throw new Error("grants relation down");
        const [localUserId, keycloakSub, repositoryRid] = params as [
          string | null,
          string | null,
          string | null,
        ];
        const now = Date.now();
        const rows = grants
          .filter((g) => g.revoked_at === null)
          .filter(
            (g) =>
              (g.subject_type === "local_user" && g.subject_id === localUserId) ||
              (g.subject_type === "keycloak_sub" && g.subject_id === keycloakSub),
          )
          .filter(
            (g) =>
              g.scope_type === "global" ||
              (g.scope_type === "repository" && g.scope_rid === repositoryRid),
          )
          .map((g) => ({
            ...g,
            is_active: g.expires_at === null || Date.parse(g.expires_at) > now,
          }));
        return { rows, rowCount: rows.length, command: "", oid: 0, fields: [] };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    },
  };
}

function baseEnv(): void {
  process.env.FUNCTION_EXECUTION_TRUST_MODE = "trusted-authors-only";
  delete process.env.FUNCTION_TRUSTED_AUTHOR_IDS;
  delete process.env.FUNCTION_PUBLISH_ROLE;
}

const RID_A = "ri.stemma.main.repository.aaaaaaaa-0000-0000-0000-000000000001";
const RID_B = "ri.stemma.main.repository.bbbbbbbb-0000-0000-0000-000000000002";

describe("authorizePublish", () => {
  it("fails closed: no role, no grant, no env entry -> deny + audit", async () => {
    baseEnv();
    const db = makeDb({});
    const d = await authorizePublish(db, {
      localUserId: "u-1",
      keycloakSub: "kc-1",
      roles: ["reader"],
      repositoryRid: RID_A,
      releaseTag: "1.0.0",
    });
    expect(d.allowed).toBe(false);
    expect(d.source).toBe("denied");
    expect(db.audit).toHaveLength(1);
    expect(db.audit[0]).toMatchObject({
      event_type: "publish_denied",
      decision_source: "denied",
      repository_rid: RID_A,
      release_tag: "1.0.0",
      local_user_id: "u-1",
      keycloak_sub: "kc-1",
    });
  });

  it("allows via the Keycloak publish role (global), configurable name", async () => {
    baseEnv();
    const db = makeDb({});
    const d = await authorizePublish(db, {
      localUserId: "u-1",
      roles: ["function:publish"],
      repositoryRid: RID_A,
    });
    expect(d).toMatchObject({ allowed: true, source: "keycloak_role" });

    process.env.FUNCTION_PUBLISH_ROLE = "custom-publisher";
    const d2 = await authorizePublish(db, {
      localUserId: "u-2",
      roles: ["function:publish"],
      repositoryRid: RID_A,
    });
    expect(d2.allowed).toBe(false); // default role no longer honored
    const d3 = await authorizePublish(db, {
      localUserId: "u-2",
      roles: ["custom-publisher"],
      repositoryRid: RID_A,
    });
    expect(d3).toMatchObject({ allowed: true, source: "keycloak_role" });
  });

  it("allows via a global DB grant on local_user id OR keycloak_sub", async () => {
    baseEnv();
    const db = makeDb({
      grants: [
        {
          id: "g-1",
          subject_type: "local_user",
          subject_id: "u-1",
          scope_type: "global",
          scope_rid: null,
          expires_at: null,
          revoked_at: null,
        },
        {
          id: "g-2",
          subject_type: "keycloak_sub",
          subject_id: "kc-2",
          scope_type: "global",
          scope_rid: null,
          expires_at: null,
          revoked_at: null,
        },
      ],
    });
    const d1 = await authorizePublish(db, { localUserId: "u-1", repositoryRid: RID_A });
    expect(d1).toMatchObject({ allowed: true, source: "db_grant", grantId: "g-1" });
    const d2 = await authorizePublish(db, {
      localUserId: "u-2",
      keycloakSub: "kc-2",
      repositoryRid: RID_A,
    });
    expect(d2).toMatchObject({ allowed: true, source: "db_grant", grantId: "g-2" });
    const d3 = await authorizePublish(db, { localUserId: "u-3", repositoryRid: RID_A });
    expect(d3.allowed).toBe(false);
  });

  it("repository-scoped grants admit only the matching RID", async () => {
    baseEnv();
    const db = makeDb({
      grants: [
        {
          id: "g-1",
          subject_type: "local_user",
          subject_id: "u-1",
          scope_type: "repository",
          scope_rid: RID_A,
          expires_at: null,
          revoked_at: null,
        },
      ],
    });
    const yes = await authorizePublish(db, { localUserId: "u-1", repositoryRid: RID_A });
    expect(yes).toMatchObject({ allowed: true, source: "db_grant" });
    const no = await authorizePublish(db, { localUserId: "u-1", repositoryRid: RID_B });
    expect(no.allowed).toBe(false);
    expect(no.source).toBe("denied");
  });

  it("expired grants deny with the grant_expired_denial event", async () => {
    baseEnv();
    const db = makeDb({
      grants: [
        {
          id: "g-1",
          subject_type: "local_user",
          subject_id: "u-1",
          scope_type: "global",
          scope_rid: null,
          expires_at: new Date(Date.now() - 60_000).toISOString(),
          revoked_at: null,
        },
      ],
    });
    const d = await authorizePublish(db, { localUserId: "u-1", repositoryRid: RID_A });
    expect(d).toMatchObject({ allowed: false, source: "denied", grantId: "g-1" });
    expect(d.reason).toBe("function-publish-grant-expired");
    expect(db.audit[0]).toMatchObject({
      event_type: "grant_expired_denial",
      grant_id: "g-1",
    });
  });

  it("revoked grants deny", async () => {
    baseEnv();
    const db = makeDb({
      grants: [
        {
          id: "g-1",
          subject_type: "local_user",
          subject_id: "u-1",
          scope_type: "global",
          scope_rid: null,
          expires_at: null,
          revoked_at: new Date().toISOString(),
        },
      ],
    });
    const d = await authorizePublish(db, { localUserId: "u-1", repositoryRid: RID_A });
    expect(d.allowed).toBe(false);
    expect(db.audit[0]).toMatchObject({ event_type: "publish_denied" });
  });

  it("legacy FUNCTION_TRUSTED_AUTHOR_IDS still admits, audited as env_allowlist, warning once", async () => {
    baseEnv();
    process.env.FUNCTION_TRUSTED_AUTHOR_IDS = "kc-1 u-9";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const db = makeDb({});
    const d = await authorizePublish(db, {
      localUserId: "u-1",
      keycloakSub: "kc-1",
      repositoryRid: RID_A,
    });
    expect(d).toMatchObject({ allowed: true, source: "env_allowlist" });
    expect(db.audit[0]).toMatchObject({
      event_type: "publish_allowed",
      decision_source: "env_allowlist",
    });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("env_allowlist_deprecated"),
    );
    // unmatched ids still deny
    const d2 = await authorizePublish(db, {
      localUserId: "u-x",
      repositoryRid: RID_A,
    });
    expect(d2.allowed).toBe(false);
  });

  it("open-development admits everyone outside production", async () => {
    process.env.NODE_ENV = "test";
    process.env.FUNCTION_EXECUTION_TRUST_MODE = "open-development";
    delete process.env.FUNCTION_TRUSTED_AUTHOR_IDS;
    const db = makeDb({});
    const d = await authorizePublish(db, { localUserId: "mallory", repositoryRid: RID_A });
    expect(d).toMatchObject({ allowed: true, source: "open_development" });
  });

  it("open-development is refused in production -> deny", async () => {
    process.env.NODE_ENV = "production";
    process.env.FUNCTION_EXECUTION_TRUST_MODE = "open-development";
    delete process.env.FUNCTION_TRUSTED_AUTHOR_IDS;
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const db = makeDb({});
    const d = await authorizePublish(db, { localUserId: "mallory", repositoryRid: RID_A });
    expect(d.allowed).toBe(false);
  });

  it("flips an allow to deny when the audit write fails (unaudited publication refused)", async () => {
    baseEnv();
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const db = makeDb({ failAudit: true });
    const d = await authorizePublish(db, {
      localUserId: "u-1",
      roles: ["function:publish"],
      repositoryRid: RID_A,
    });
    expect(d).toMatchObject({
      allowed: false,
      source: "denied",
      auditFailed: true,
      reason: "publish-audit-unavailable",
    });
    expect(error).toHaveBeenCalled();
  });

  it("a deny with a failed audit write stays a plain deny", async () => {
    baseEnv();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const db = makeDb({ failAudit: true });
    const d = await authorizePublish(db, { localUserId: "u-1", repositoryRid: RID_A });
    expect(d).toMatchObject({ allowed: false, source: "denied" });
    expect(d.auditFailed).toBeUndefined();
  });

  it("fails closed when the grants table is unreadable (DB down)", async () => {
    baseEnv();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const db = makeDb({ failGrants: true });
    const d = await authorizePublish(db, { localUserId: "u-1", repositoryRid: RID_A });
    expect(d).toMatchObject({
      allowed: false,
      source: "denied",
      reason: "publish-authorization-unavailable",
    });
    // The denial itself is still audited (audit table healthy here).
    expect(db.audit[0]).toMatchObject({ event_type: "publish_denied" });
  });

  it("every decision writes exactly one audit row", async () => {
    baseEnv();
    const db = makeDb({});
    await authorizePublish(db, { localUserId: "u-1", roles: ["function:publish"] });
    await authorizePublish(db, { localUserId: "u-2" });
    expect(db.audit.map((a) => a.event_type)).toEqual([
      "publish_allowed",
      "publish_denied",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Legacy contract deprecation controls
// ---------------------------------------------------------------------------

describe("legacy contract deprecation controls", () => {
  it("legacy executions are allowed by default", () => {
    delete process.env.FUNCTION_LEGACY_CONTRACT_DISABLED;
    expect(isLegacyContractExecutionAllowed()).toBe(true);
  });

  it("FUNCTION_LEGACY_CONTRACT_DISABLED=true blocks legacy executions", () => {
    process.env.FUNCTION_LEGACY_CONTRACT_DISABLED = "true";
    expect(isLegacyContractExecutionAllowed()).toBe(false);
  });

  it("parses a valid deprecation date and rejects malformed ones", () => {
    process.env.FUNCTION_LEGACY_CONTRACT_DEPRECATION_DATE = "2026-12-31";
    expect(executionPolicy().legacyDeprecationDate).toBe("2026-12-31");
    process.env.FUNCTION_LEGACY_CONTRACT_DEPRECATION_DATE = "31/12/2026";
    expect(executionPolicy().legacyDeprecationDate).toBeNull();
  });
});
