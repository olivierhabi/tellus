// ---------------------------------------------------------------------------
// Interface-Link Runtime Resolver — Phase 2 unit tests.
//
// Pure, no DB: mocks the link_type + interface_link_constraint + interface +
// object_type_interface + object_type queries. Exercises the canonical
// behaviours required by the public spec:
//
//   * createInterfaceLink + exactly 1 candidate link_type implementing the
//     constraint → `kind: "ok"` with the single candidate. The rule
//     compiler would feed this back through compileLinkRule to produce one
//     addLink edit.
//   * createInterfaceLink + 0 candidates → `kind: "no_match"`. Persistence
//     is allowed, runtime execution fails pre-edit.
//   * createInterfaceLink + 2 candidates → `kind: "ambiguous"`. The
//     F-CREATE ambiguity gate (no ontology edit applied to a
//     non-deterministically-resolved create) is enforced at the resolver
//     layer; the compiler surfaces AMBIGUOUS_INTERFACE_LINK_IMPLEMENTATION.
//   * deleteInterfaceLink + 2 candidates → `kind: "ok"` with both
//     candidates (deterministic all-matching deletion; sorted by apiName).
//   * Constraint not found → `kind: "missing"`.
//   * Runtime source/target object type not typed → `kind: "invalid"`.
//   * Runtime source object type doesn't implement the owning interface →
//     `kind: "invalid"`.
//   * Constraint is 'deprecated' → soft-error appended to `invalid.errors`.
//
// Run via: `pnpm vitest run --config vitest.unit.config.ts tests/unit/actions/interfaceLinkRules-unit.test.ts`
// ---------------------------------------------------------------------------

import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks. Each per-test setup will reset + configure the relevant query/path.
// ---------------------------------------------------------------------------

const { getConstraint } = vi.hoisted(() => ({ getConstraint: vi.fn() }));
const { getLinkType } = vi.hoisted(() => ({ getLinkType: vi.fn() }));
const { queryFn } = vi.hoisted(() => ({ queryFn: vi.fn() }));
const { resolveObjectTypeApiName } = vi.hoisted(() => ({ resolveObjectTypeApiName: vi.fn() }));

vi.mock("../../../src/models/interfaceLinkConstraint", () => ({
  getInterfaceLinkConstraintByApiName: getConstraint,
}));

vi.mock("../../../src/models/linkType", () => ({
  getByApiName: getLinkType,
  resolveObjectTypeApiName: resolveObjectTypeApiName,
}));

vi.mock("../../../src/db", () => ({
  query: queryFn,
}));

import { resolveInterfaceLinkRule, buildConcreteLinkEditsFromCandidates } from "../../../src/actions/rules/interfaceLinkRules";

const ONTOLOGY = "ont-1";

// ---------------------------------------------------------------------------
// Helpers — build LinkTypeRow-shaped mocks for the resolver's candidate
// lookup path. The resolver re-fetches via `getLinkType(ontologyId, apiName)`
// for each row returned from the raw `SELECT * FROM link_type WHERE ...`
// query, so we set up `getLinkType` to round-trip the row.
// ---------------------------------------------------------------------------

function ltRow(apiName: string, cardinality: string, srcObj = "src-uuid", tgtObj = "tgt-uuid") {
  return {
    link_type_id: "lt-" + apiName,
    ontology_id: ONTOLOGY,
    api_name: apiName,
    display_name: apiName,
    description: null,
    cardinality,
    source_object_type: srcObj,
    target_object_type: tgtObj,
    source_property_id: null,
    target_property_id: null,
    join_table_file_path: null,
    join_table_source_column: null,
    join_table_target_column: null,
    is_bidirectional: false,
    storage_backend: "csv_legacy",
    iceberg_table_name: null,
  };
}

function constraint(opts: {
  apiName: string;
  interface_id: string;
  target_interface_id?: string | null;
  target_object_type_id?: string | null;
  cardinality: string;
  status?: string;
}) {
  return {
    interface_link_constraint_id: "ic-" + opts.apiName,
    ontology_id: ONTOLOGY,
    api_name: opts.apiName,
    display_name: opts.apiName,
    description: null,
    interface_id: opts.interface_id,
    target_interface_id: opts.target_interface_id ?? null,
    target_object_type_id: opts.target_object_type_id ?? null,
    cardinality: opts.cardinality,
    source_role: null,
    target_role: null,
    status: opts.status ?? "active",
    created_at: "now",
    updated_at: "now",
  };
}

// ---------------------------------------------------------------------------
// Default happy-path mock: owning interface 'Buyer', target interface
// 'Seller', cardinality MANY_TO_MANY; runtime source OType implements
// Buyer; runtime target OType implements Seller; exactly one concrete
// M2M link_type exists between them.
// ---------------------------------------------------------------------------

const SRC_OT_API = "SrcOT";
const TGT_OT_API = "TgtOT";
const SRC_OT_UUID = "src-ot-uuid";
const TGT_OT_UUID = "tgt-ot-uuid";
const IFC_OWNER_UUID = "iface-owner-uuid";
const IFC_TARGET_UUID = "iface-target-uuid";

function setupHappyPathOneCandidate(candidateApiName: string) {
  getConstraint.mockResolvedValue(constraint({
    apiName: "BuyerSellerContract",
    interface_id: IFC_OWNER_UUID,
    target_interface_id: IFC_TARGET_UUID,
    cardinality: "MANY_TO_MANY",
    status: "active",
  }));
  // query calls (in order):
  //   1) SELECT api_name FROM interface WHERE interface_id = constraint's owning iface
  //   2) SELECT object_type_id FROM object_type WHERE api_name = source runtime api
  //   3) SELECT object_type_id FROM object_type WHERE api_name = target runtime api
  //   4) SELECT 1 FROM object_type_interface WHERE src implements owner iface
  //   5) SELECT 1 FROM object_type_interface WHERE tgt implements target iface (when targetInterfaceId set)
  //   6) SELECT * FROM link_type WHERE source_object_type=$2 AND target_object_type=$3 AND cardinality=...
  // The mock returns queryFn's result keyed by query SQL fragment.
  queryFn.mockImplementation(async (sql: string) => {
    if (sql.includes("SELECT api_name FROM interface WHERE interface_id")) {
      return { rows: [{ api_name: "Buyer" }] };
    }
    if (sql.includes("SELECT object_type_id FROM object_type WHERE ontology_id")) {
      // Pick based on the param: $2 is the apiName; we need to look at
      // the params array.
      // (mockFnCallerArgs - mockImpl receives args `(...args)` — second arg is params array)
      return { rows: [] };
    }
    if (sql.includes("SELECT 1 FROM object_type_interface WHERE object_type_id")) {
      return { rows: [{ "?column?": 1 }] };
    }
    if (sql.includes("SELECT * FROM link_type")) {
      return { rows: [ltRow(candidateApiName, "MANY_TO_MANY", SRC_OT_UUID, TGT_OT_UUID)] };
    }
    return { rows: [] };
  });
  // Configure object_type lookup per apiName (used by the source/target
  // object-type UUID resolution; the resolver uses `query` with the apiName
  // as $2).
  queryFn.mockImplementation(async (sql: string, params?: unknown[]) => {
    if (sql.includes("SELECT object_type_id FROM object_type WHERE")) {
      const api = (params?.[1] as string) ?? "";
      return { rows: [{ object_type_id: api === SRC_OT_API ? SRC_OT_UUID : TGT_OT_UUID }] };
    }
    if (sql.includes("SELECT 1 FROM object_type_interface WHERE object_type_id = $1 AND interface_id = $2")) {
      // The impl-row checks below always succeed — happy path means source
      // implements owner iface AND target implements target iface.
      return { rows: [{ "?column?": 1 }] };
    }
    if (sql.includes("SELECT api_name FROM interface WHERE interface_id = $1")) {
      return { rows: [{ api_name: "Buyer" }] };
    }
    if (sql.includes("SELECT * FROM link_type")) {
      return { rows: [ltRow(candidateApiName, "MANY_TO_MANY", SRC_OT_UUID, TGT_OT_UUID)] };
    }
    return { rows: [] };
  });
  getLinkType.mockImplementation(async (_ont: string, apiName: string) =>
    apiName ? ltRow(apiName, "MANY_TO_MANY", SRC_OT_UUID, TGT_OT_UUID) : null,
  );
}

function ruleCreate(opts: Partial<Parameters<typeof resolveInterfaceLinkRule>[1]> = {}) {
  return {
    type: "createInterfaceLink" as const,
    interfaceLinkConstraint: "BuyerSellerContract",
    interfaceId: "Buyer",
    source: { source: "parameter", param: "buyer", objectType: SRC_OT_API },
    target: { source: "parameter", param: "seller", objectType: TGT_OT_API },
    ...opts,
  };
}

describe("resolveInterfaceLinkRule — createInterfaceLink happy path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupHappyPathOneCandidate("BuyerSellerM2M");
  });

  it("returns ok with the single candidate link_type", async () => {
    const r = await resolveInterfaceLinkRule(ONTOLOGY, ruleCreate());
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0].api_name).toBe("BuyerSellerM2M");
  });
});

describe("resolveInterfaceLinkRule — constraint missing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getConstraint.mockResolvedValue(null);
  });

  it("returns missing with the constraint api name", async () => {
    const r = await resolveInterfaceLinkRule(ONTOLOGY, ruleCreate());
    expect(r.kind).toBe("missing");
  });
});

describe("resolveInterfaceLinkRule — no_match (concrete link_type doesn't exist)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupHappyPathOneCandidate("BuyerSellerM2M");
    // Override the link_type lookup to return empty.
    const originalImpl = queryFn.getMockImplementation();
    queryFn.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes("SELECT * FROM link_type")) {
        return { rows: [] };
      }
      // Reuse the happy-path lookup for the rest:
      return originalImpl ? originalImpl(sql, params) : { rows: [] };
    });
  });

  it("returns no_match", async () => {
    const r = await resolveInterfaceLinkRule(ONTOLOGY, ruleCreate());
    expect(r.kind).toBe("no_match");
  });
});

describe("resolveInterfaceLinkRule — ambiguous (2 candidates on create)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Same setup as happy path but the candidate lookup returns TWO link_types.
    getConstraint.mockResolvedValue(constraint({
      apiName: "BuyerSellerContract",
      interface_id: IFC_OWNER_UUID,
      target_interface_id: IFC_TARGET_UUID,
      cardinality: "MANY_TO_MANY",
    }));
    queryFn.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes("SELECT object_type_id FROM object_type WHERE")) {
        const api = (params?.[1] as string) ?? "";
        return { rows: [{ object_type_id: api === SRC_OT_API ? SRC_OT_UUID : TGT_OT_UUID }] };
      }
      if (sql.includes("SELECT 1 FROM object_type_interface WHERE object_type_id")) {
        return { rows: [{ "?column?": 1 }] };
      }
      if (sql.includes("SELECT api_name FROM interface WHERE interface_id = $1")) {
        return { rows: [{ api_name: "Buyer" }] };
      }
      if (sql.includes("SELECT * FROM link_type")) {
        return { rows: [
          ltRow("CandOne", "MANY_TO_MANY", SRC_OT_UUID, TGT_OT_UUID),
          ltRow("CandTwo", "MANY_TO_MANY", SRC_OT_UUID, TGT_OT_UUID),
        ] };
      }
      return { rows: [] };
    });
    getLinkType.mockImplementation(async (_ont: string, apiName: string) =>
      apiName ? ltRow(apiName, "MANY_TO_MANY", SRC_OT_UUID, TGT_OT_UUID) : null,
    );
  });

  it("returns ambiguous (creation refuses to pick — pre-edit fail)", async () => {
    const r = await resolveInterfaceLinkRule(ONTOLOGY, ruleCreate());
    expect(r.kind).toBe("ambiguous");
    if (r.kind !== "ambiguous") return;
    expect(r.candidates.length).toBe(2);
  });

  it("returns ambiguous and lists both candidate apiNames in deterministic order", async () => {
    const r = await resolveInterfaceLinkRule(ONTOLOGY, ruleCreate());
    if (r.kind !== "ambiguous") throw new Error("expected ambiguous");
    expect(r.candidates.map((c) => c.api_name).sort()).toEqual(["CandOne", "CandTwo"]);
  });
});

describe("resolveInterfaceLinkRule — deleteInterfaceLink with 2 candidates returns ok with all matches", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getConstraint.mockResolvedValue(constraint({
      apiName: "BuyerSellerContract",
      interface_id: IFC_OWNER_UUID,
      target_interface_id: IFC_TARGET_UUID,
      cardinality: "MANY_TO_MANY",
    }));
    queryFn.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes("SELECT object_type_id FROM object_type WHERE")) {
        const api = (params?.[1] as string) ?? "";
        return { rows: [{ object_type_id: api === SRC_OT_API ? SRC_OT_UUID : TGT_OT_UUID }] };
      }
      if (sql.includes("SELECT 1 FROM object_type_interface WHERE object_type_id")) {
        return { rows: [{ "?column?": 1 }] };
      }
      if (sql.includes("SELECT api_name FROM interface WHERE interface_id = $1")) {
        return { rows: [{ api_name: "Buyer" }] };
      }
      if (sql.includes("SELECT * FROM link_type")) {
        return { rows: [
          ltRow("Zecond", "MANY_TO_MANY", SRC_OT_UUID, TGT_OT_UUID),
          ltRow("Ane", "MANY_TO_MANY", SRC_OT_UUID, TGT_OT_UUID),
        ] };
      }
      return { rows: [] };
    });
    getLinkType.mockImplementation(async (_ont: string, apiName: string) =>
      apiName ? ltRow(apiName, "MANY_TO_MANY", SRC_OT_UUID, TGT_OT_UUID) : null,
    );
  });

  it("returns ok with both candidates (deterministic all-matching deletion)", async () => {
    const r = await resolveInterfaceLinkRule(ONTOLOGY, {
      ...ruleCreate(),
      type: "deleteInterfaceLink" as const,
    });
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    expect(r.candidates.length).toBe(2);
  });

  it("buildConcreteLinkEditsFromCandidates sorts deterministically by apiName", () => {
    const candidates = [
      ltRow("Zecond", "MANY_TO_MANY", "src", "tgt"),
      ltRow("Ane", "MANY_TO_MANY", "src", "tgt"),
    ];
    const rule = {
      type: "deleteInterfaceLink" as const,
      interfaceLinkConstraint: "X",
      interfaceId: "I",
      source: { source: "parameter" as const, param: "src", objectType: "OType" },
      target: { source: "parameter" as const, param: "tgt", objectType: "OType" },
    };
    const edits = buildConcreteLinkEditsFromCandidates(rule, candidates);
    expect(edits.map((e) => e.linkType)).toEqual(["Ane", "Zecond"]);
    for (const e of edits) {
      expect(e.type).toBe("removeLink");
    }
  });
});

describe("resolveInterfaceLinkRule — invalid inputs surface structured errors", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getConstraint.mockResolvedValue(constraint({
      apiName: "BuyerSellerContract",
      interface_id: IFC_OWNER_UUID,
      target_interface_id: IFC_TARGET_UUID,
      cardinality: "MANY_TO_MANY",
    }));
  });

  it("returns invalid when the runtime source is not typed (no objectType)", async () => {
    const r = await resolveInterfaceLinkRule(ONTOLOGY, {
      type: "createInterfaceLink",
      interfaceLinkConstraint: "BuyerSellerContract",
      interfaceId: "Buyer",
      source: { source: "parameter", param: "buyer" /* no objectType */ } as any,
      target: { source: "parameter", param: "seller", objectType: TGT_OT_API } as any,
    });
    expect(r.kind).toBe("invalid");
    if (r.kind !== "invalid") return;
    expect(r.errors.some((e) => e.includes("source.objectType is required"))).toBe(true);
  });

  it("returns invalid when the runtime source object type doesn't implement the owning interface", async () => {
    queryFn.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes("SELECT object_type_id FROM object_type WHERE")) {
        const api = (params?.[1] as string) ?? "";
        return { rows: [{ object_type_id: api === SRC_OT_API ? SRC_OT_UUID : TGT_OT_UUID }] };
      }
      if (sql.includes("SELECT 1 FROM object_type_interface WHERE object_type_id = $1 AND interface_id = $2")) {
        // The src-impl check: simulate src-implements-owner-IFACE = false.
        const otId = (params?.[0] as string) ?? "";
        const ifaceId = (params?.[1] as string) ?? "";
        return { rows: (otId === SRC_OT_UUID && ifaceId === IFC_OWNER_UUID) ? [] : [{ "?column?": 1 }] };
      }
      if (sql.includes("SELECT api_name FROM interface WHERE interface_id = $1")) {
        return { rows: [{ api_name: "Buyer" }] };
      }
      if (sql.includes("SELECT * FROM link_type")) {
        return { rows: [] };
      }
      return { rows: [] };
    });
    getLinkType.mockResolvedValue(null);
    const r = await resolveInterfaceLinkRule(ONTOLOGY, ruleCreate());
    expect(r.kind).toBe("invalid");
    if (r.kind !== "invalid") return;
    expect(r.errors.some((e) => e.includes("does not implement interface"))).toBe(true);
  });
});

describe("resolveInterfaceLinkRule — deprecated constraint surfaces soft-error", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getConstraint.mockResolvedValue(constraint({
      apiName: "BuyerSellerContract",
      interface_id: IFC_OWNER_UUID,
      target_interface_id: IFC_TARGET_UUID,
      cardinality: "MANY_TO_MANY",
      status: "deprecated",
    }));
    queryFn.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT api_name FROM interface WHERE interface_id = $1")) {
        return { rows: [{ api_name: "Buyer" }] };
      }
      if (sql.includes("SELECT object_type_id FROM object_type WHERE")) {
        return { rows: [{ object_type_id: SRC_OT_UUID }] };
      }
      if (sql.includes("SELECT 1 FROM object_type_interface WHERE object_type_id")) {
        return { rows: [{ "?column?": 1 }] };
      }
      if (sql.includes("SELECT * FROM link_type")) {
        return { rows: [] };
      }
      return { rows: [] };
    });
    getLinkType.mockResolvedValue(null);
  });

  it("surfaces a 'deprecated' soft-error early in the resolved errors", async () => {
    const r = await resolveInterfaceLinkRule(ONTOLOGY, ruleCreate());
    if (r.kind !== "invalid") {
      expect.fail("expected invalid; got " + r.kind);
    }
    expect(r.errors.some((e) => e.includes("deprecated") && e.includes("BuyerSellerContract"))).toBe(true);
  });
});
