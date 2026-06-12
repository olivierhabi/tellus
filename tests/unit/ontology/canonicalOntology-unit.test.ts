// ---------------------------------------------------------------------------
// canonicalOntology-unit.test.ts
// Regression tests for "One Enterprise, One Ontology" core resolver logic.
// ---------------------------------------------------------------------------
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the DB layer so importing the module never opens a real pool and we can
// drive getOntologyId()'s branches deterministically.
vi.mock("../../../src/db", () => ({ query: vi.fn() }));

import { query } from "../../../src/db";
import {
  ENTERPRISE_ONTOLOGY_UUID,
  ENTERPRISE_ONTOLOGY_RID,
  isCanonicalOntologyId,
  coerceToCanonicalOntologyId,
  enterpriseOntologyRid,
  collapseOntologyUrl,
  getOntologyId,
  __resetCanonicalCache,
} from "../../../src/services/ontology/canonicalOntology";

const CANON = "00000000-0000-0000-0000-000000000001";
const mockQuery = query as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockQuery.mockReset();
  __resetCanonicalCache();
});

describe("canonical identity constants", () => {
  it("UUID and RID are the fixed enterprise identity", () => {
    expect(ENTERPRISE_ONTOLOGY_UUID).toBe(CANON);
    expect(ENTERPRISE_ONTOLOGY_RID).toBe(`ri.ontology.main.ontology.${CANON}`);
    expect(enterpriseOntologyRid()).toBe(ENTERPRISE_ONTOLOGY_RID);
  });
});

describe("isCanonicalOntologyId", () => {
  it("is true only for the canonical UUID (case-insensitive)", () => {
    expect(isCanonicalOntologyId(CANON)).toBe(true);
    expect(isCanonicalOntologyId(CANON.toUpperCase())).toBe(true);
    expect(isCanonicalOntologyId(` ${CANON} `)).toBe(true);
    expect(isCanonicalOntologyId("3edc794a-7add-4b03-923a-c3a7054d5677")).toBe(false);
    expect(isCanonicalOntologyId(null)).toBe(false);
    expect(isCanonicalOntologyId(undefined)).toBe(false);
    expect(isCanonicalOntologyId("")).toBe(false);
  });
});

describe("coerceToCanonicalOntologyId", () => {
  it("collapses ANY input to the canonical UUID", () => {
    for (const input of [
      "default", "main", "primary",
      "ffffffff-ffff-ffff-ffff-ffffffffffff",
      "ri.ontology.main.ontology.deadbeef",
      "garbage", "", null, undefined,
    ]) {
      expect(coerceToCanonicalOntologyId(input as string)).toBe(CANON);
    }
  });
});

describe("collapseOntologyUrl", () => {
  it("rewrites a non-canonical ontology id segment to canonical", () => {
    expect(collapseOntologyUrl("/api/v1/ontology/abc/objectTypes", CANON))
      .toBe(`/api/v1/ontology/${CANON}/objectTypes`);
    expect(collapseOntologyUrl("/api/v1/ontology/default", CANON))
      .toBe(`/api/v1/ontology/${CANON}`);
    expect(collapseOntologyUrl("/api/v1/ontology/abc?x=1", CANON))
      .toBe(`/api/v1/ontology/${CANON}?x=1`);
    expect(collapseOntologyUrl("/api/v1/ontology/11111111-2222-3333-4444-555555555555/linkTypes/x", CANON))
      .toBe(`/api/v1/ontology/${CANON}/linkTypes/x`);
  });

  it("returns null when no rewrite is needed", () => {
    // already canonical
    expect(collapseOntologyUrl(`/api/v1/ontology/${CANON}/objectTypes`, CANON)).toBeNull();
    // the import lifecycle sub-route is excluded
    expect(collapseOntologyUrl("/api/v1/ontology/import", CANON)).toBeNull();
    // bare list/create path (no id segment)
    expect(collapseOntologyUrl("/api/v1/ontology", CANON)).toBeNull();
    // unrelated paths
    expect(collapseOntologyUrl("/api/v1/objects/Foo/search", CANON)).toBeNull();
    expect(collapseOntologyUrl("/health", CANON)).toBeNull();
  });
});

describe("getOntologyId", () => {
  it("returns the canonical UUID when the canonical row exists, and caches it", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ ontology_id: CANON }] });
    expect(await getOntologyId()).toBe(CANON);
    // Cached: a second call must not hit the DB again.
    expect(await getOntologyId()).toBe(CANON);
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it("falls back to the single existing ontology when canonical is absent (not cached)", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] }) // canonical lookup: missing
      .mockResolvedValueOnce({ rows: [{ ontology_id: "legacy-1" }] }); // fallback
    expect(await getOntologyId()).toBe("legacy-1");
    // Not cached — re-resolves so it switches to canonical once the migration lands.
    mockQuery
      .mockResolvedValueOnce({ rows: [{ ontology_id: CANON }] });
    expect(await getOntologyId()).toBe(CANON);
  });

  it("returns null when no ontology exists at all", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] }) // canonical
      .mockResolvedValueOnce({ rows: [] }); // fallback
    expect(await getOntologyId()).toBeNull();
  });

  it("returns null (never throws) when the DB is unreachable", async () => {
    mockQuery.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    expect(await getOntologyId()).toBeNull();
  });
});
