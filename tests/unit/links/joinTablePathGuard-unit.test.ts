/**
 * Finding B (CWE-22) — joinTableFilePath path-traversal guard.
 *
 * Pins the containment helper in linkResolverService and the defense-in-depth
 * refusal inside parseJoinTableCSV:
 *
 *   - absolute paths outside the upload dir are rejected;
 *   - "../" traversal escaping the upload dir is rejected;
 *   - sibling-prefix bypasses (data/join_tables_evil) are rejected;
 *   - null bytes are rejected;
 *   - legitimate paths inside the upload dir (as produced by the
 *     /:apiName/upload multer route) are accepted and parsed;
 *   - a nonexistent file INSIDE the upload dir still returns [] (legacy
 *     contract preserved).
 *
 * JOIN_TABLE_DIR points at a temp root so the test never depends on the
 * repo's real data/ tree (the guard reads the env override on every call).
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/db", () => ({
  query: vi.fn(async () => ({ rows: [] })),
  getClient: vi.fn(),
  withTransaction: vi.fn(),
}));

vi.mock("../../../src/services/opensearch/client", () => ({
  client: {
    search: vi.fn(),
    count: vi.fn(),
    get: vi.fn(),
    indices: { exists: vi.fn() },
  },
  injectSecurityFilter: (body: unknown) => body,
}));

import {
  isSafeJoinTablePath,
  joinTableBaseDir,
  resolveLegacyCsvM2mPks,
} from "../../../src/services/linkResolverService";

let tmpRoot: string;
let joinDir: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(path.join(tmpdir(), "jt-guard-"));
  joinDir = path.join(tmpRoot, "data", "join_tables");
  mkdirSync(joinDir, { recursive: true });
  process.env.JOIN_TABLE_DIR = joinDir;
});

afterEach(() => {
  delete process.env.JOIN_TABLE_DIR;
  rmSync(tmpRoot, { recursive: true, force: true });
});

const lt = (join_table_file_path: string) =>
  ({
    link_type_id: "lt-test",
    api_name: "orders",
    join_table_file_path,
    cardinality: "MANY_TO_MANY",
  } as any);

describe("isSafeJoinTablePath (the check the create/update routes call)", () => {
  it("accepts a legitimate upload path inside the join-table dir", () => {
    expect(isSafeJoinTablePath(path.join(joinDir, "1710000000000-report.csv"))).toBe(true);
  });

  it("rejects absolute paths outside the upload dir", () => {
    expect(isSafeJoinTablePath("/etc/passwd")).toBe(false);
    expect(isSafeJoinTablePath(tmpRoot)).toBe(false);
  });

  it("rejects the base dir itself (must be a file strictly inside)", () => {
    expect(isSafeJoinTablePath(joinDir)).toBe(false);
  });

  it("rejects ../ traversal escaping the upload dir", () => {
    expect(isSafeJoinTablePath(path.join(joinDir, "..", "..", "secrets.csv"))).toBe(false);
    expect(isSafeJoinTablePath("../../etc/passwd")).toBe(false);
  });

  it("rejects sibling-prefix bypasses (join_tables_evil)", () => {
    const evil = path.join(tmpRoot, "data", "join_tables_evil", "x.csv");
    expect(isSafeJoinTablePath(evil)).toBe(false);
    expect(isSafeJoinTablePath(`${joinDir}_evil/x.csv`)).toBe(false);
  });

  it("rejects null-byte injection", () => {
    expect(isSafeJoinTablePath(`${joinDir}/x.csv\0`)).toBe(false);
    expect(isSafeJoinTablePath(`${joinDir}/x.csv\0.png`)).toBe(false);
  });

  it("honors the JOIN_TABLE_DIR override on every call", () => {
    expect(joinTableBaseDir()).toBe(joinDir);
    expect(isSafeJoinTablePath(path.join(joinDir, "ok.csv"))).toBe(true);
    // A path inside the REPO default (cwd/data/join_tables) is NOT accepted
    // while the override points elsewhere — containment follows the env.
    const repoDefault = path.join(process.cwd(), "data", "join_tables", "ok.csv");
    expect(isSafeJoinTablePath(repoDefault)).toBe(false);
  });
});

describe("parseJoinTableCSV containment (defense-in-depth)", () => {
  it("refuses to read an out-of-tree file", () => {
    expect(() => resolveLegacyCsvM2mPks(lt("/etc/passwd"), ["root"], "forward")).toThrow(
      /outside/,
    );
  });

  it("refuses traversal that resolves outside the upload dir", () => {
    const traversal = path.join(joinDir, "..", "..", "..", "etc", "passwd");
    expect(() => resolveLegacyCsvM2mPks(lt(traversal), ["root"], "forward")).toThrow(/outside/);
  });

  it("refuses null-byte paths", () => {
    expect(() => resolveLegacyCsvM2mPks(lt(`${joinDir}/x.csv\0`), ["s1"], "forward")).toThrow(
      /outside/,
    );
  });

  it("parses a legitimate in-tree CSV (the upload flow's output)", () => {
    const csvPath = path.join(joinDir, "1710000000000-report.csv");
    writeFileSync(csvPath, "src_pk,tgt_pk\ns1,t1\ns1,t2\ns2,t3\n");
    expect(resolveLegacyCsvM2mPks(lt(csvPath), ["s1"], "forward")).toEqual(["t1", "t2"]);
    expect(resolveLegacyCsvM2mPks(lt(csvPath), ["t3"], "reverse")).toEqual(["s2"]);
  });

  it("returns [] for a missing in-tree file (legacy contract preserved)", () => {
    const missing = path.join(joinDir, "missing.csv");
    expect(resolveLegacyCsvM2mPks(lt(missing), ["s1"], "forward")).toEqual([]);
  });
});
