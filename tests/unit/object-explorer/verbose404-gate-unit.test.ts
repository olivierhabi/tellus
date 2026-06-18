// ---------------------------------------------------------------------------
// T-07 — verbose-404 gate unit tests.
//
// Covers contract C-104: ensureObjectTypeExists must NOT leak the
// `api_name` catalog in production. The verbose body is gated behind
// the dual condition NODE_ENV !== "production" AND TELLUS_DEBUG_404 ===
// "true" so staging (which often runs as production) keeps the
// production-shape behavior.
//
// We exercise the helper directly via the `__internals` seam exposed in
// src/routes/objects.ts — no Express app, no live DB.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Mock `query` from src/db so ensureObjectTypeExists doesn't need a DB.
const queryMock = vi.fn();
vi.mock("../../../src/db", () => ({
  default: { query: queryMock },
  query: (sql: string, args: unknown[]) => queryMock(sql, args),
}));

// Mock heavy downstreams so importing src/routes/objects.ts is cheap.
vi.mock("../../../src/services/queryExecutor", () => ({
  executeSearch: vi.fn(),
  executeGetObject: vi.fn(),
  executeAggregate: vi.fn(),
  executeFullTextSearch: vi.fn(),
}));
vi.mock("../../../src/services/queryValidator", () => ({
  validateSearchQuery: vi.fn(() => ({})),
  validateListQuery: vi.fn(() => ({})),
  validateAggregateQuery: vi.fn(() => ({})),
}));
vi.mock("../../../src/services/linkResolverService", () => ({
  resolveLinks: vi.fn(),
  countLinks: vi.fn(),
  searchAround: vi.fn(),
  validateForeignKeys: vi.fn(),
}));
vi.mock("../../../src/models/linkType", () => ({
  default: { getByApiName: vi.fn() },
}));
vi.mock("../../../src/services/overlay/writebackOverlay", () => ({
  applyOverlayToResults: vi.fn((x: unknown) => x),
  mergeOverlayIntoSearch: vi.fn((x: unknown) => x),
}));
vi.mock("../../../src/services/overlay/getOverlayStore", () => ({
  getOverlayStore: vi.fn(() => null),
}));
vi.mock("../../../src/services/overlay/overlayStore", () => ({
  overlayKey: (b: string | null, ot: string, pk: string) => `o:${b ?? "_main"}:${ot}:${pk}`,
}));
vi.mock("../../../src/services/funnel/shadowDiffHook", () => ({
  recordShadowDiff: vi.fn(),
}));

const ORIGINAL_ENV = { ...process.env };

async function loadHelper(): Promise<
  (objectType: string) => Promise<void>
> {
  // Re-import after each env mutation so the gate captures the new env.
  vi.resetModules();
  const mod = (await import("../../../src/routes/objects")) as any;
  return mod.__internals.ensureObjectTypeExists;
}

describe("T-07 ensureObjectTypeExists — verbose-404 gate (C-104)", () => {
  beforeEach(() => {
    queryMock.mockReset();
    queryMock.mockImplementation(async (sql: string) => {
      if (/SELECT 1 FROM object_type/.test(sql)) return { rows: [] };
      if (/ORDER BY api_name/.test(sql)) {
        return {
          rows: [
            { api_name: "Trip" },
            { api_name: "Driver" },
            { api_name: "Vehicle" },
          ],
        };
      }
      return { rows: [] };
    });
    delete process.env.NODE_ENV;
    delete process.env.TELLUS_DEBUG_404;
  });
  afterEach(() => {
    Object.assign(process.env, ORIGINAL_ENV);
  });

  it("T-07 C-104a: production (no debug flag) → terse message + parameters.objectType, NO catalog leak", async () => {
    process.env.NODE_ENV = "production";
    const ensure = await loadHelper();
    let caught: any;
    try {
      await ensure("NotARealType");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    expect(caught.code).toBe("OBJECT_TYPE_NOT_FOUND");
    expect(caught.message).toBe("Object type not found.");
    expect(caught.details?.objectType).toBe("NotARealType");
    expect(caught.details?.available).toBeUndefined();
    const catalogQueries = queryMock.mock.calls.filter((c: any[]) =>
      /ORDER BY api_name/.test(c[0]),
    );
    expect(catalogQueries.length).toBe(0);
  });

  it("T-07 C-104b: production WITH TELLUS_DEBUG_404=true still does NOT leak (NODE_ENV gate)", async () => {
    process.env.NODE_ENV = "production";
    process.env.TELLUS_DEBUG_404 = "true";
    const ensure = await loadHelper();
    let caught: any;
    try {
      await ensure("NotARealType");
    } catch (e) {
      caught = e;
    }
    expect(caught.message).toBe("Object type not found.");
    expect(caught.details?.available).toBeUndefined();
  });

  it("T-07 C-104c: dev WITHOUT TELLUS_DEBUG_404 still does NOT leak (debug gate)", async () => {
    process.env.NODE_ENV = "development";
    const ensure = await loadHelper();
    let caught: any;
    try {
      await ensure("NotARealType");
    } catch (e) {
      caught = e;
    }
    expect(caught.message).toBe("Object type not found.");
    expect(caught.details?.available).toBeUndefined();
  });

  it("T-07 C-104d: dev WITH TELLUS_DEBUG_404=true emits the verbose hint", async () => {
    process.env.NODE_ENV = "development";
    process.env.TELLUS_DEBUG_404 = "true";
    const ensure = await loadHelper();
    let caught: any;
    try {
      await ensure("NotARealType");
    } catch (e) {
      caught = e;
    }
    expect(caught.message).toContain("NotARealType");
    expect(caught.message).toContain("Trip");
    expect(caught.details?.available).toEqual([
      "Trip",
      "Driver",
      "Vehicle",
    ]);
  });

  it("T-07 C-104e: when type exists, ensureObjectTypeExists resolves without throwing", async () => {
    queryMock.mockReset();
    queryMock.mockImplementation(async (sql: string) => {
      if (/SELECT 1 FROM object_type/.test(sql)) return { rows: [{ "?column?": 1 }] };
      return { rows: [] };
    });
    process.env.NODE_ENV = "production";
    const ensure = await loadHelper();
    await expect(ensure("ExistingType")).resolves.toBeUndefined();
  });
});
