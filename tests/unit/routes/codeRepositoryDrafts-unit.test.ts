// ---------------------------------------------------------------------------
// Unit tests for the uncommitted-drafts store (migration 104).
//
// Run:  npx vitest run --config vitest.unit.config.ts
//                  tests/unit/routes/codeRepositoryDrafts-unit.test.ts
//
// Pure: validateDraftsBody is a pure function; the store functions are
// exercised against a mock pool (no DB / no server / no Keycloak).
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  validateDraftsBody,
  listDrafts,
  replaceDrafts,
  clearDrafts,
  type StoredDraftInput,
} from "../../../src/services/codeRepository/drafts/draftStore";

// ---------------------------------------------------------------------------
// validateDraftsBody
// ---------------------------------------------------------------------------

describe("validateDraftsBody", () => {
  it("accepts a valid add draft (no base) with default mode", () => {
    const r = validateDraftsBody({
      drafts: [{ path: "src/functions/foo.ts", content: "export const x = 1;" }],
    });
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    expect(r.drafts).toHaveLength(1);
    expect(r.drafts[0]).toEqual<StoredDraftInput>({
      path: "src/functions/foo.ts",
      content: "export const x = 1;",
      baseSha: null,
      baseContent: null,
      mode: "100644",
    });
  });

  it("accepts a modify draft (baseSha + baseContent) with explicit mode", () => {
    const sha = "0".repeat(40);
    const r = validateDraftsBody({
      drafts: [
        {
          path: "src/existing.ts",
          content: "edited",
          baseSha: sha,
          baseContent: "original",
          mode: "100755",
        },
      ],
    });
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    expect(r.drafts[0]?.baseSha).toBe(sha);
    expect(r.drafts[0]?.baseContent).toBe("original");
    expect(r.drafts[0]?.mode).toBe("100755");
  });

  it("rejects a non-object body", () => {
    expect(validateDraftsBody("nope").kind).toBe("invalid");
    expect(validateDraftsBody(null).kind).toBe("invalid");
    expect(validateDraftsBody([]).kind).toBe("invalid");
  });

  it("rejects a non-array drafts field", () => {
    const r = validateDraftsBody({ drafts: "not-array" });
    expect(r.kind).toBe("invalid");
    if (r.kind !== "invalid") return;
    expect(r.errorName).toBe("CodeRepos:InvalidSettings");
  });

  it("rejects an empty path and a traversal path", () => {
    expect(
      validateDraftsBody({ drafts: [{ path: "", content: "x" }] }).kind,
    ).toBe("invalid");
    const r = validateDraftsBody({
      drafts: [{ path: "../escape.ts", content: "x" }],
    });
    expect(r.kind).toBe("invalid");
    if (r.kind !== "invalid") return;
    expect(r.errorName).toBe("CodeRepos:InvalidPath");
  });

  it("rejects non-string content", () => {
    const r = validateDraftsBody({
      drafts: [{ path: "a.ts", content: 42 }],
    });
    expect(r.kind).toBe("invalid");
    if (r.kind !== "invalid") return;
    expect(r.errorName).toBe("CodeRepos:InvalidSettings");
  });

  it("rejects an oversize draft content (DraftTooLarge)", () => {
    const r = validateDraftsBody({
      drafts: [{ path: "big.ts", content: "x".repeat(5 * 1024 * 1024 + 1) }],
    });
    expect(r.kind).toBe("invalid");
    if (r.kind !== "invalid") return;
    expect(r.errorName).toBe("CodeRepos:DraftTooLarge");
  });

  it("rejects a malformed baseSha", () => {
    const r = validateDraftsBody({
      drafts: [{ path: "a.ts", content: "x", baseSha: "not-a-sha" }],
    });
    expect(r.kind).toBe("invalid");
    if (r.kind !== "invalid") return;
    expect(r.errorName).toBe("CodeRepos:InvalidSettings");
  });

  it("rejects a bad mode", () => {
    const r = validateDraftsBody({
      drafts: [{ path: "a.ts", content: "x", mode: "999" }],
    });
    expect(r.kind).toBe("invalid");
  });

  it("rejects duplicate paths", () => {
    const r = validateDraftsBody({
      drafts: [
        { path: "a.ts", content: "x" },
        { path: "a.ts", content: "y" },
      ],
    });
    expect(r.kind).toBe("invalid");
    if (r.kind !== "invalid") return;
    expect(r.errorName).toBe("CodeRepos:InvalidSettings");
  });

  it("rejects more than 500 drafts (DraftLimitExceeded)", () => {
    const drafts = Array.from({ length: 501 }, (_, i) => ({
      path: `f${i}.ts`,
      content: "x",
    }));
    const r = validateDraftsBody({ drafts });
    expect(r.kind).toBe("invalid");
    if (r.kind !== "invalid") return;
    expect(r.errorName).toBe("CodeRepos:DraftLimitExceeded");
  });

  it("accepts an empty drafts array (clears the set)", () => {
    const r = validateDraftsBody({ drafts: [] });
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    expect(r.drafts).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// draftStore — listDrafts / replaceDrafts / clearDrafts (mock pool)
// ---------------------------------------------------------------------------

interface DraftRowDb {
  path: string;
  content: Buffer;
  base_sha: string | null;
  base_content: Buffer | null;
  mode: string;
  version: string | number;
  updated_at: string | Date;
}

function makeMockPool(initialRows: DraftRowDb[] = []) {
  const rows: DraftRowDb[] = [...initialRows];
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const resultFor = (sql: string) => {
    const t = sql.trimStart();
    if (/^SELECT/i.test(t)) return { rows: rows.slice(), rowCount: rows.length };
    return { rows: [], rowCount: 0 };
  };
  const client = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      return resultFor(sql);
    }),
    release: vi.fn(),
  };
  const pool = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      return resultFor(sql);
    }),
    connect: vi.fn(async () => client),
  };
  return { pool, client, calls, setRows: (r: DraftRowDb[]) => {
    rows.length = 0;
    rows.push(...r);
  } };
}

const ARGS = {
  principalSub: "11111111-2222-4333-8444-555555555555",
  repositoryRid: "ri.stemma.main.repository.test",
  branch: "main",
};

describe("draftStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("listDrafts maps DB rows (utf-8 content, numeric version, ISO updated_at)", async () => {
    const { pool } = makeMockPool([
      {
        path: "src/new.ts",
        content: Buffer.from("hello", "utf-8"),
        base_sha: null,
        base_content: null,
        mode: "100644",
        version: "3",
        updated_at: "2026-06-29T00:00:00.000Z",
      },
    ]);
    const out = await listDrafts(pool as any, ARGS);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      path: "src/new.ts",
      content: "hello",
      baseSha: null,
      baseContent: null,
      mode: "100644",
      version: 3,
      updatedAt: "2026-06-29T00:00:00.000Z",
    });
  });

  it("clearDrafts issues a DELETE scoped to (principal, repo, branch)", async () => {
    const { pool, calls } = makeMockPool();
    await clearDrafts(pool as any, ARGS);
    const del = calls.find((c) => /DELETE FROM code_repository_draft/i.test(c.sql));
    expect(del).toBeDefined();
    expect(del?.params).toEqual([ARGS.principalSub, ARGS.repositoryRid, ARGS.branch]);
  });

  it("replaceDrafts runs BEGIN/DELETE/INSERT/SELECT/COMMIT and returns the rows", async () => {
    const { pool, client, calls } = makeMockPool([
      {
        path: "src/new.ts",
        content: Buffer.from("hello", "utf-8"),
        base_sha: null,
        base_content: null,
        mode: "100644",
        version: "1",
        updated_at: "2026-06-29T00:00:00.000Z",
      },
    ]);
    const out = await replaceDrafts(pool as any, {
      ...ARGS,
      drafts: [
        { path: "src/new.ts", content: "hello", baseSha: null, baseContent: null, mode: "100644" },
      ],
    });
    const seq = calls.map((c) => c.sql.trimStart().split(/\s+/)[0]).join(" ");
    expect(seq).toBe("BEGIN DELETE INSERT SELECT COMMIT");
    expect(out).toHaveLength(1);
    expect(out[0]?.content).toBe("hello");
    // connect + release were used (tx discipline).
    expect(pool.connect).toHaveBeenCalledTimes(1);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it("replaceDrafts with an empty set deletes all (no INSERT) and still commits", async () => {
    const { pool, calls } = makeMockPool([]);
    const out = await replaceDrafts(pool as any, { ...ARGS, drafts: [] });
    const seq = calls.map((c) => c.sql.trimStart().split(/\s+/)[0]).join(" ");
    expect(seq).toBe("BEGIN DELETE SELECT COMMIT");
    expect(out).toHaveLength(0);
  });

  it("replaceDrafts rolls back and rethrows if a query fails", async () => {
    const { pool, client, calls } = makeMockPool();
    client.query.mockImplementationOnce(async () => "BEGIN-ok" as any);
    client.query.mockImplementationOnce(async () => {
      throw new Error("insert blew up");
    });
    await expect(
      replaceDrafts(pool as any, {
        ...ARGS,
        drafts: [{ path: "a.ts", content: "x", baseSha: null, baseContent: null, mode: "100644" }],
      }),
    ).rejects.toThrow("insert blew up");
    const hasRollback = calls.some((c) => /ROLLBACK/i.test(c.sql));
    expect(hasRollback).toBe(true);
    expect(client.release).toHaveBeenCalledTimes(1);
  });
});
