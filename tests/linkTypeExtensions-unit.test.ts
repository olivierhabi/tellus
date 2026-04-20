// ---------------------------------------------------------------------------
// Unit tests for LT-B1..B10 link-type extensions.
//
// Targets the pure-logic helpers that underpin the feature set:
//   - reverse-direction projection + cardinality mirror (LT-B6)
//   - MCP propagation modes + marking predicate (LT-B7)
//   - PK-cap effective calculation + Wilson interval (LT-B2, LT-B5)
//   - search_after token encode/decode round-trip + offset cap (LT-B9)
//   - CDC v2 payload validation (LT-B3)
//
// Run: npx vitest run tests/linkTypeExtensions.test.ts
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import type { LinkTypeRow } from "../src/models/linkType";
import {
  applyReverseProjection,
  applyReverseProjectionAll,
  reverseCardinality,
  deriveEdgeMarkings,
  mcpPredicateForRow,
} from "../src/services/linkDirectionHelpers";
import { effectiveMaxPks } from "../src/models/linkResolverConfig";
import { wilsonInterval } from "../src/services/linkOrphanState";
import {
  encodeSearchAfter,
  decodeSearchAfter,
  isSearchAfterToken,
  assertOffsetWithinCap,
  OffsetTooDeepError,
} from "../src/services/linkPagination";
import { validateLinkCdcV2 } from "../src/services/searchAround/cdcLinkProducer";

function mkLinkType(overrides: Partial<LinkTypeRow> = {}): LinkTypeRow {
  return {
    link_type_id: "lt-1",
    ontology_id: "ont-1",
    api_name: "employed_by",
    display_name: "Employed By",
    description: null,
    cardinality: "ONE_TO_MANY",
    source_object_type: "ot-emp",
    target_object_type: "ot-co",
    source_property_id: null,
    target_property_id: null,
    join_table_file_path: null,
    join_table_source_column: null,
    join_table_target_column: null,
    is_bidirectional: false,
    created_at: "2026-01-01",
    updated_at: "2026-01-01",
    storage_backend: "csv_legacy",
    violation_policy: "warn",
    violation_count_24h: 0,
    reverse_visible: true,
    reverse_actions_enabled: true,
    mcp_propagation_mode: "union",
    mcp_required_count: 1,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// LT-B6 — reverse projection + cardinality mirror
// ---------------------------------------------------------------------------

describe("LT-B6 reverse-direction helpers", () => {
  it("keeps only `included` props when direction=reverse", () => {
    const hit = { __pk: "E001", fullName: "Alice", salary: 100000, secret: "x" };
    const lt = mkLinkType({
      reverse_property_projection: { included: ["fullName"] },
    });
    const out = applyReverseProjection(hit, lt, "reverse");
    expect(out.__pk).toBe("E001");
    expect(out.fullName).toBe("Alice");
    expect(out.salary).toBeUndefined();
    expect(out.secret).toBeUndefined();
  });

  it("drops `excluded` props when direction=reverse", () => {
    const hit = { __pk: "E001", fullName: "Alice", secret: "x" };
    const lt = mkLinkType({
      reverse_property_projection: { excluded: ["secret"] },
    });
    const out = applyReverseProjection(hit, lt, "reverse");
    expect(out.fullName).toBe("Alice");
    expect(out.secret).toBeUndefined();
  });

  it("leaves hits untouched when direction=forward", () => {
    const hit = { __pk: "E001", salary: 100000 };
    const lt = mkLinkType({
      reverse_property_projection: { included: ["none"] },
    });
    const out = applyReverseProjection(hit, lt, "forward");
    expect(out.salary).toBe(100000);
  });

  it("leaves hits untouched when no projection is configured", () => {
    const hit = { __pk: "E001", salary: 100000 };
    const lt = mkLinkType();
    expect(applyReverseProjection(hit, lt, "reverse")).toEqual(hit);
  });

  it("batch applies projection", () => {
    const hits = [
      { __pk: "1", a: 1, b: 2 },
      { __pk: "2", a: 3, b: 4 },
    ];
    const lt = mkLinkType({ reverse_property_projection: { excluded: ["b"] } });
    const out = applyReverseProjectionAll(hits, lt, "reverse");
    expect(out[0]).toEqual({ __pk: "1", a: 1 });
    expect(out[1]).toEqual({ __pk: "2", a: 3 });
  });

  it("reverses cardinality view", () => {
    expect(reverseCardinality("ONE_TO_MANY")).toBe("MANY_TO_ONE");
    expect(reverseCardinality("MANY_TO_ONE")).toBe("ONE_TO_MANY");
    expect(reverseCardinality("ONE_TO_ONE")).toBe("ONE_TO_ONE");
    expect(reverseCardinality("MANY_TO_MANY")).toBe("MANY_TO_MANY");
  });
});

// ---------------------------------------------------------------------------
// LT-B7 — MCP propagation + predicate
// ---------------------------------------------------------------------------

describe("LT-B7 mandatory control properties", () => {
  it("union merges source and target markings with de-dup", () => {
    const lt = mkLinkType({ mcp_propagation_mode: "union" });
    expect(deriveEdgeMarkings(lt, ["RESTRICTED"], ["SECRET"])).toEqual(
      expect.arrayContaining(["RESTRICTED", "SECRET"])
    );
  });

  it("intersection keeps only overlapping markings", () => {
    const lt = mkLinkType({ mcp_propagation_mode: "intersection" });
    expect(deriveEdgeMarkings(lt, ["A", "B"], ["B", "C"])).toEqual(["B"]);
  });

  it("source-only propagation ignores target markings", () => {
    const lt = mkLinkType({ mcp_propagation_mode: "source" });
    expect(deriveEdgeMarkings(lt, ["A"], ["B"])).toEqual(["A"]);
  });

  it("mcpPredicateForRow denies rows when user lacks required markings", () => {
    const lt = mkLinkType({
      mandatory_control_property_id: "prop-123",
      mcp_required_count: 1,
    });
    expect(mcpPredicateForRow(lt, ["SECRET"], ["SECRET", "RESTRICTED"])).toBe(true);
    expect(mcpPredicateForRow(lt, ["SECRET"], ["PUBLIC"])).toBe(false);
  });

  it("mcpPredicateForRow is pass-through when MCP is not configured", () => {
    const lt = mkLinkType();
    expect(mcpPredicateForRow(lt, ["SECRET"], [])).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// LT-B2 — PK cap effective value
// ---------------------------------------------------------------------------

describe("LT-B2 effectiveMaxPks", () => {
  it("returns tenant cap when no override provided", () => {
    const r = effectiveMaxPks(100_000);
    expect(r.effective).toBe(100_000);
    expect(r.clamped).toBe(false);
  });

  it("honors override within tenant + global caps", () => {
    const r = effectiveMaxPks(500_000, 250_000);
    expect(r.effective).toBe(250_000);
    expect(r.clamped).toBe(false);
  });

  it("clamps override above tenant cap", () => {
    const r = effectiveMaxPks(100_000, 500_000);
    expect(r.effective).toBe(100_000);
    expect(r.clamped).toBe(true);
  });

  it("clamps override above global hard cap", () => {
    const r = effectiveMaxPks(5_000_000, 10_000_000, 1_000_000);
    expect(r.effective).toBe(1_000_000);
    expect(r.clamped).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// LT-B5 — Wilson score interval for orphan rate CI
// ---------------------------------------------------------------------------

describe("LT-B5 wilsonInterval", () => {
  it("returns [0,1] on empty sample", () => {
    const { lower, upper } = wilsonInterval(0, 0);
    expect(lower).toBe(0);
    expect(upper).toBe(1);
  });

  it("collapses as trials grow", () => {
    const a = wilsonInterval(5, 10);
    const b = wilsonInterval(500, 1000);
    expect(b.upper - b.lower).toBeLessThan(a.upper - a.lower);
  });

  it("keeps lower bound non-negative even with 0 successes", () => {
    const { lower } = wilsonInterval(0, 100);
    expect(lower).toBeGreaterThanOrEqual(0);
  });

  it("keeps upper bound at or below 1", () => {
    const { upper } = wilsonInterval(100, 100);
    expect(upper).toBeLessThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// LT-B9 — search_after pagination tokens
// ---------------------------------------------------------------------------

describe("LT-B9 search_after tokens", () => {
  it("round-trips a token losslessly", () => {
    const tok = {
      sort_keys: ["E001", 1700000000],
      pit_id: "pit-abc",
      backend: "opensearch" as const,
    };
    const encoded = encodeSearchAfter(tok);
    const decoded = decodeSearchAfter(encoded);
    expect(decoded.sort_keys).toEqual(tok.sort_keys);
    expect(decoded.pit_id).toBe(tok.pit_id);
    expect(decoded.backend).toBe(tok.backend);
  });

  it("isSearchAfterToken detects encoded payloads", () => {
    const encoded = encodeSearchAfter({
      sort_keys: ["x"],
      pit_id: null,
      backend: "opensearch",
    });
    expect(isSearchAfterToken(encoded)).toBe(true);
    expect(isSearchAfterToken("not-a-token")).toBe(false);
    expect(isSearchAfterToken(undefined)).toBe(false);
  });

  it("rejects offsets beyond the 10_000 cap", () => {
    expect(() => assertOffsetWithinCap(10_001)).toThrow(OffsetTooDeepError);
    expect(() => assertOffsetWithinCap(10_000)).not.toThrow();
  });

  it("surfaces a machine-readable error code", () => {
    try {
      assertOffsetWithinCap(99_999);
    } catch (err) {
      expect((err as OffsetTooDeepError).code).toBe(
        "OFFSET_TOO_DEEP_USE_SEARCH_AFTER"
      );
    }
  });
});

// ---------------------------------------------------------------------------
// LT-B3 — CDC v2 payload validation
// ---------------------------------------------------------------------------

describe("LT-B3 CDC v2 validator", () => {
  it("accepts a complete payload", () => {
    const result = validateLinkCdcV2({
      source_pk: "E001",
      target_pk: "C001",
      schema_version: "2.0.0",
      event_id: "evt-1",
      event_ts_micros: Date.now() * 1000,
      ontology_id: "ont-1",
      link_type_api_name: "employed_by",
      operation: "ADD",
      actor_principal_id: "alice",
    });
    expect(result.ok).toBe(true);
  });

  it("rejects missing event_id / ontology_id", () => {
    const result = validateLinkCdcV2({
      source_pk: "E001",
      target_pk: "C001",
      operation: "ADD",
      link_type_api_name: "employed_by",
    });
    if (result.ok === false) {
      expect(result.errors).toEqual(
        expect.arrayContaining([
          "event_id is required (v2)",
          "ontology_id is required (v2)",
        ])
      );
    } else {
      throw new Error("expected validation to fail");
    }
  });

  it("requires retracts_event_id for RETRACT operations", () => {
    const result = validateLinkCdcV2({
      source_pk: "E001",
      target_pk: "C001",
      event_id: "evt-2",
      event_ts_micros: 1,
      ontology_id: "ont-1",
      link_type_api_name: "employed_by",
      operation: "RETRACT",
    });
    if (result.ok === false) {
      expect(result.errors).toContain(
        "RETRACT requires retracts_event_id pointing at the original event"
      );
    } else {
      throw new Error("expected validation to fail");
    }
  });

  it("rejects unknown operations", () => {
    const result = validateLinkCdcV2({
      source_pk: "E001",
      target_pk: "C001",
      event_id: "evt-3",
      event_ts_micros: 1,
      ontology_id: "ont-1",
      link_type_api_name: "employed_by",
      operation: "FOO" as unknown as "ADD",
    });
    if (result.ok === false) {
      expect(result.errors.some((e) => /operation must be/.test(e))).toBe(true);
    } else {
      throw new Error("expected validation to fail");
    }
  });
});
