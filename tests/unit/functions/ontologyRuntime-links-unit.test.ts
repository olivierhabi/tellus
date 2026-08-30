// ---------------------------------------------------------------------------
// Link Type traversal in TypeScript Functions — Foundry parity tests.
//
// Mirrors docs/foundry/functions/api-objects-links §"Link types":
//   • 1 side  → SingleLink:  `obj.parentLink.get()`  → Object | undefined
//   • N side  → MultiLink:   `obj.childLinks.all()`  → Object[]
//   • Filtered MultiLink `.search()` for large collections
//   • ObjectSet link pivots: `set.searchAround(link)` and the generated
//     `set.searchAroundToX()` methods, so traversals avoid loading linked
//     object instances into memory first.
//   • Safe unwrapping: missing relations yield undefined / empty arrays.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import {
  buildOntologySdk,
  loadOntologySnapshot,
  type LinkSnapshotDef,
  type OntologyObject,
  type OntologySnapshot,
} from "../../../src/services/functions/ontologyRuntime";

function makeObject(apiName: string, pk: string, props: Record<string, unknown> = {}): OntologyObject {
  return { $apiName: apiName, $primaryKey: pk, $title: pk, ...props };
}

function makeSnapshot(
  types: Record<string, Record<string, Record<string, unknown>>>,
  links: LinkSnapshotDef[] = [],
): OntologySnapshot {
  const byType = new Map<string, Map<string, OntologyObject>>();
  for (const [apiName, byPk] of Object.entries(types)) {
    const bucket = new Map<string, OntologyObject>();
    for (const [pk, props] of Object.entries(byPk)) bucket.set(pk, makeObject(apiName, pk, props));
    byType.set(apiName, bucket);
  }
  return {
    byType,
    ontologyId: "ont-1",
    objectCount: [...byType.values()].reduce((n, b) => n + b.size, 0),
    objectTypes: Object.keys(types),
    links: new Map(links.map((l) => [l.apiName, l])),
  };
}

function linkDef(p: {
  apiName: string;
  cardinality: LinkSnapshotDef["cardinality"];
  sourceType: string;
  targetType: string;
  forward: Record<string, string[]>;
  reverse: Record<string, string[]>;
  reverseApiName?: string | null;
}): LinkSnapshotDef {
  return {
    apiName: p.apiName,
    reverseApiName: p.reverseApiName ?? null,
    cardinality: p.cardinality,
    sourceType: p.sourceType,
    targetType: p.targetType,
    forward: new Map(Object.entries(p.forward)),
    reverse: new Map(Object.entries(p.reverse)),
  };
}

// Test graph: Line(1) --(equipments)--> Equipment(N) --(site)--> Site(1)
// Equipment(1) --(workOrders)--> WorkOrder(N)
const EQUIPMENTS = linkDef({
  apiName: "equipments",
  cardinality: "ONE_TO_MANY",
  sourceType: "Line",
  targetType: "Equipment",
  forward: { line1: ["eq1", "eq2"], line2: ["eq3"] },
  reverse: { eq1: ["line1"], eq2: ["line1"], eq3: ["line2"] },
  reverseApiName: "productionLine",
});
const SITE = linkDef({
  apiName: "site",
  cardinality: "MANY_TO_ONE",
  sourceType: "Equipment",
  targetType: "Site",
  forward: { eq1: ["siteA"], eq2: ["siteA"] },
  reverse: { siteA: ["eq1", "eq2"] },
  reverseApiName: "equipment",
});
const WORK_ORDERS = linkDef({
  apiName: "workOrders",
  cardinality: "MANY_TO_MANY",
  sourceType: "Equipment",
  targetType: "WorkOrder",
  forward: { eq1: ["wo9"] },
  reverse: { wo9: ["eq1"] },
  reverseApiName: "equipment",
});

function twinSnapshot(): OntologySnapshot {
  return makeSnapshot(
    {
      Line: {
        line1: { name: "Line 1" },
        line2: { name: "Line 2" },
        line3: { name: "Line 3 (no equipment)" },
      },
      Equipment: {
        eq1: { currentOee: 0.8, operationalStatus: "RUNNING" },
        eq2: { currentOee: 0.6, operationalStatus: "DOWN" },
        eq3: { currentOee: null, operationalStatus: "RUNNING" },
        eqOrphan: { currentOee: 1, operationalStatus: "RUNNING" },
      },
      Site: { siteA: { name: "Kigali" } },
      WorkOrder: { wo9: { status: "OPEN" } },
    },
    [EQUIPMENTS, SITE, WORK_ORDERS],
  );
}

describe("Link accessors — MultiLink (many side)", () => {
  it("line.equipments.all() resolves the linked children in order", () => {
    const { sdk } = buildOntologySdk(twinSnapshot());
    const line = sdk.Objects.get("Line", "line1")!;
    const eqs = (line as unknown as { equipments: { all(): OntologyObject[] } }).equipments.all();
    expect(eqs.map((e) => e.$primaryKey)).toEqual(["eq1", "eq2"]);
  });

  it("missing relations unwrap safely to an empty array (never undefined/throw)", () => {
    const { sdk } = buildOntologySdk(twinSnapshot());
    const line3 = sdk.Objects.get("Line", "line3")!;
    const eqs = (line3 as unknown as { equipments: { all(): OntologyObject[] } }).equipments.all();
    expect(eqs).toEqual([]);
  });

  it("Pattern 1 (doc): bottom-up rollup over running equipment", () => {
    const { sdk } = buildOntologySdk(twinSnapshot());
    const line = sdk.Objects.get("Line", "line1")! as unknown as {
      equipments: { all(): Array<{ operationalStatus?: string; currentOee?: number | null }> };
    };
    const running = line.equipments.all().filter((e) => e.operationalStatus === "RUNNING");
    const oee = running.reduce((s, e) => s + (e.currentOee ?? 0), 0) / running.length;
    expect(running).toHaveLength(1);
    expect(oee).toBeCloseTo(0.8);
  });

  it("MultiLink.search narrows with a predicate and returns a chainable ObjectSet", () => {
    const { sdk } = buildOntologySdk(twinSnapshot());
    const site = sdk.Objects.get("Site", "siteA")! as unknown as {
      equipment: { search(pred: (e: OntologyObject) => unknown): { count(): number; sum(f: string): number } };
    };
    const running = site.equipment.search((e) => e.operationalStatus === "RUNNING");
    expect(running.count()).toBe(1);
    expect(running.sum("currentOee")).toBeCloseTo(0.8);
  });

  it("MultiLink.search accepts an equality where-map", () => {
    const { sdk } = buildOntologySdk(twinSnapshot());
    const site = sdk.Objects.get("Site", "siteA")! as unknown as {
      equipment: { search(where: Record<string, unknown>): { count(): number } };
    };
    expect(site.equipment.search({ operationalStatus: "DOWN" }).count()).toBe(1);
  });

  it("MANY_TO_MANY exposes multi accessors on both directions", () => {
    const { sdk } = buildOntologySdk(twinSnapshot());
    const eq1 = sdk.Objects.get("Equipment", "eq1")! as unknown as {
      workOrders: { all(): OntologyObject[] };
    };
    const wo9 = sdk.Objects.get("WorkOrder", "wo9")! as unknown as {
      equipment: { all(): OntologyObject[] };
    };
    expect(eq1.workOrders.all().map((o) => o.$primaryKey)).toEqual(["wo9"]);
    expect(wo9.equipment.all().map((o) => o.$primaryKey)).toEqual(["eq1"]);
  });
});

describe("Link accessors — SingleLink (1 side)", () => {
  it("equipment.site.get() resolves the parent", () => {
    const { sdk } = buildOntologySdk(twinSnapshot());
    const eq1 = sdk.Objects.get("Equipment", "eq1")! as unknown as {
      site: { get(): OntologyObject | undefined };
    };
    expect(eq1.site.get()?.$primaryKey).toBe("siteA");
  });

  it("links traverse reverse: line.productionLine reverse accessor name is per-link", () => {
    const { sdk } = buildOntologySdk(twinSnapshot());
    const eq1 = sdk.Objects.get("Equipment", "eq1")! as unknown as {
      productionLine: { get(): OntologyObject | undefined };
    };
    expect(eq1.productionLine.get()?.$primaryKey).toBe("line1");
  });

  it("safe unwrapping: a dangling/missing relation returns undefined", () => {
    const { sdk } = buildOntologySdk(twinSnapshot());
    const eq3 = sdk.Objects.get("Equipment", "eq3")! as unknown as {
      site: { get(): OntologyObject | undefined };
    };
    expect(eq3.site.get()).toBeUndefined();
  });

  it("async variants resolve to the same values (getAsync/allAsync)", async () => {
    const { sdk } = buildOntologySdk(twinSnapshot());
    const eq1 = sdk.Objects.get("Equipment", "eq1")! as unknown as {
      site: { getAsync(): Promise<OntologyObject | undefined> };
      productionLine: { getAsync(): Promise<OntologyObject | undefined> };
      workOrders: { allAsync(): Promise<OntologyObject[]> };
    };
    await expect(eq1.site.getAsync()).resolves.toMatchObject({ $primaryKey: "siteA" });
    await expect(eq1.workOrders.allAsync()).resolves.toHaveLength(1);
  });
});

describe("Link accessors — mechanics & multi-hop", () => {
  it("accessors are non-enumerable: JSON.stringify/spread of objects is unchanged", () => {
    const { sdk } = buildOntologySdk(twinSnapshot());
    const line = sdk.Objects.get("Line", "line1")!;
    expect(Object.keys(line)).not.toContain("equipments");
    expect(JSON.stringify(line)).not.toContain("equipments");
  });

  it("nested multi-hop traversal returns the SAME decorated instances", () => {
    const { sdk } = buildOntologySdk(twinSnapshot());
    const line = sdk.Objects.get("Line", "line1")! as unknown as {
      equipments: { all(): Array<{ site: { get(): OntologyObject | undefined } }> };
    };
    // Hop 1: line → equipment, Hop 2: equipment → site.
    expect(line.equipments.all()[0].site.get()?.$primaryKey).toBe("siteA");
  });

  it("traversal is counted in per-type object-load instrumentation", () => {
    const snap = twinSnapshot();
    const { sdk, getObjectLoads } = buildOntologySdk(snap);
    const line = sdk.Objects.get("Line", "line1")! as unknown as {
      equipments: { all(): OntologyObject[] };
    };
    line.equipments.all();
    const loads = getObjectLoads();
    expect(loads.find((l) => l.objectType === "Equipment")?.calls).toBeGreaterThanOrEqual(1);
  });

  it("no links in snapshot → no accessors attached (fail-silent pre-feature behaviour)", () => {
    const snap = makeSnapshot({ Line: { l1: {} } });
    const { sdk } = buildOntologySdk(snap);
    const line = sdk.Objects.get("Line", "l1")!;
    expect((line as unknown as { equipments?: unknown }).equipments).toBeUndefined();
  });

  it("a data property with the same name is never shadowed", () => {
    const snap = makeSnapshot(
      { Equipment: { eq1: { currentOee: 1, site: "LITERAL-PROP" } }, Site: { siteA: {} } },
      [SITE],
    );
    const { sdk } = buildOntologySdk(snap);
    expect(sdk.Objects.get("Equipment", "eq1")!.site).toBe("LITERAL-PROP");
  });
});

describe("ObjectSet search-around (set-level pivots)", () => {
  it("searchAround pivots a set across a link by apiName", () => {
    const { sdk } = buildOntologySdk(twinSnapshot());
    const running = sdk.Objects.search("Equipment").filter((e) => e.operationalStatus === "RUNNING");
    const sites = running.searchAround("site");
    expect(sites.count()).toBe(1);
    expect(sites.first()!.$primaryKey).toBe("siteA");
  });

  it("searchAround dedupes targets reached from multiple sources", () => {
    const { sdk } = buildOntologySdk(twinSnapshot());
    const sites = sdk.Objects.search("Equipment").filter((e) => e.$primaryKey !== "eqOrphan").searchAround("site");
    expect(sites.count()).toBe(1); // eq1 + eq2 both point at siteA
  });

  it("reverse searchAround via reverseApiName", () => {
    const { sdk } = buildOntologySdk(twinSnapshot());
    const lines = sdk.Objects.search("Site").searchAround("equipment");
    expect(lines.count()).toBe(2);
  });

  it("generated searchAroundToXxx() methods resolve through the proxy", () => {
    const { sdk } = buildOntologySdk(twinSnapshot());
    const equipmentSet = sdk.Objects.search("Line").searchAround("equipments") as unknown as {
      searchAroundToSite(): { count(): number };
      searchAroundToProductionLine(): { count(): number };
    };
    expect(equipmentSet.searchAroundToSite().count()).toBe(1);
    expect(equipmentSet.searchAroundToProductionLine().count()).toBe(2);
  });

  it("multi-hop set pivot: Line → Equipment → WorkOrder", () => {
    const { sdk } = buildOntologySdk(twinSnapshot());
    const wos = sdk.Objects.search("Line")
      .filter((l) => l.$primaryKey === "line1")
      .searchAround("equipments")
      .searchAround("workOrders");
    expect(wos.count()).toBe(1);
    expect(wos.first()!.$primaryKey).toBe("wo9");
  });

  it("unknown link name fails silently to an empty set", () => {
    const { sdk } = buildOntologySdk(twinSnapshot());
    expect(sdk.Objects.search("Line").searchAround("notARealLink").count()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// loadOntologySnapshot — edge derivation from link_type metadata (FK rules
// mirrored from linkResolverService) with a stubbed pg Pool.
// ---------------------------------------------------------------------------

interface StubQuery { text?: string; values?: unknown[] }

function stubPool(plan: Array<{ match: RegExp; rows: unknown[] }>) {
  const queries: StubQuery[] = [];
  return {
    queries,
    pool: {
      async query(cfg: StubQuery | string) {
        const text = typeof cfg === "string" ? cfg : (cfg.text ?? "");
        if (typeof cfg !== "string") queries.push({ text, values: cfg.values });
        for (const step of plan) {
          if (step.match.test(text)) return { rows: step.rows };
        }
        throw new Error(`stubPool: no plan for query: ${text}`);
      },
    },
  };
}

describe("loadOntologySnapshot — link graph derivation", () => {
  it("ONE_TO_MANY: edges resolved from the target-side FK property", async () => {
    const { pool } = stubPool([
      {
        match: /FROM object_instances/,
        rows: [
          { object_type_api_name: "Customer", primary_key: "c1", properties: { name: "A" } },
          { object_type_api_name: "Account", primary_key: "a1", properties: { customerId: "c1", balance: 5 } },
          { object_type_api_name: "Account", primary_key: "a2", properties: { customerId: null } },
        ],
      },
      {
        match: /FROM link_type/,
        rows: [
          {
            api_name: "accounts",
            reverse_api_name: "customer",
            reverse_visible: true,
            cardinality: "ONE_TO_MANY",
            source_type: "Customer",
            target_type: "Account",
            source_prop: null,
            target_prop: "customerId",
            join_table_file_path: null,
          },
        ],
      },
      { match: /to_regclass/, rows: [{ exists: false }] },
    ]);
    const snap = await loadOntologySnapshot(pool as never, { ontologyId: "00000000-0000-0000-0000-000000000001" });
    expect(snap.links?.get("accounts")).toMatchObject({
      cardinality: "ONE_TO_MANY",
      sourceType: "Customer",
      targetType: "Account",
      forward: new Map([["c1", ["a1"]]]),
      reverse: new Map([["a1", ["c1"]]]),
    });
    const { sdk } = buildOntologySdk(snap);
    const cust = sdk.Objects.get("Customer", "c1")! as unknown as {
      accounts: { all(): OntologyObject[] };
    };
    expect(cust.accounts.all().map((a) => a.$primaryKey)).toEqual(["a1"]);
  });

  it("import filter: only declared link types are materialised", async () => {
    const { pool } = stubPool([
      {
        match: /FROM object_instances/,
        rows: [
          { object_type_api_name: "A", primary_key: "a", properties: {} },
          { object_type_api_name: "B", primary_key: "b", properties: { aId: "a" } },
        ],
      },
      {
        match: /FROM link_type/,
        rows: [
          {
            api_name: "bs", reverse_api_name: null, reverse_visible: true,
            cardinality: "ONE_TO_MANY", source_type: "A", target_type: "B",
            source_prop: null, target_prop: "aId", join_table_file_path: null,
          },
          {
            api_name: "bsUnimported", reverse_api_name: null, reverse_visible: true,
            cardinality: "ONE_TO_MANY", source_type: "A", target_type: "B",
            source_prop: null, target_prop: "aId", join_table_file_path: null,
          },
        ],
      },
      { match: /to_regclass/, rows: [{ exists: false }] },
    ]);
    const snap = await loadOntologySnapshot(pool as never, {
      ontologyId: "00000000-0000-0000-0000-000000000001",
      linkTypes: ["bs"],
    });
    expect(snap.links?.has("bs")).toBe(true);
    expect(snap.links?.has("bsUnimported")).toBe(false);
  });

  it("MANY_TO_ONE + union with link_instances (edit-applicator edges)", async () => {
    const { pool } = stubPool([
      {
        match: /FROM object_instances/,
        rows: [
          { object_type_api_name: "Loan", primary_key: "l1", properties: { teamId: "t1" } },
          { object_type_api_name: "Team", primary_key: "t1", properties: {} },
          { object_type_api_name: "Team", primary_key: "t2", properties: {} },
        ],
      },
      {
        match: /FROM link_type/,
        rows: [
          {
            api_name: "reviewTeam", reverse_api_name: "loans", reverse_visible: true,
            cardinality: "MANY_TO_ONE", source_type: "Loan", target_type: "Team",
            source_prop: "teamId", target_prop: null, join_table_file_path: null,
          },
        ],
      },
      { match: /to_regclass/, rows: [{ exists: true }] },
      {
        match: /FROM link_instances/,
        rows: [
          { link_type_api_name: "reviewTeam", source_primary_key: "l1", target_primary_key: "t2" },
        ],
      },
    ]);
    const snap = await loadOntologySnapshot(pool as never, { ontologyId: "00000000-0000-0000-0000-000000000001" });
    const def = snap.links?.get("reviewTeam");
    expect(def?.forward.get("l1")).toEqual(["t1", "t2"]); // FK edge + applicator edge
    expect(def?.reverse.get("t2")).toEqual(["l1"]);
  });

  it("links whose endpoint type isn't loaded are skipped", async () => {
    const { pool } = stubPool([
      {
        match: /FROM object_instances/,
        rows: [{ object_type_api_name: "A", primary_key: "a", properties: {} }],
      },
      {
        match: /FROM link_type/,
        rows: [
          {
            api_name: "toB", reverse_api_name: null, reverse_visible: true,
            cardinality: "ONE_TO_MANY", source_type: "A", target_type: "B",
            source_prop: null, target_prop: "aId", join_table_file_path: null,
          },
        ],
      },
      { match: /to_regclass/, rows: [{ exists: false }] },
    ]);
    const snap = await loadOntologySnapshot(pool as never, { ontologyId: "00000000-0000-0000-0000-000000000001" });
    expect(snap.links?.size).toBe(0);
  });
});
