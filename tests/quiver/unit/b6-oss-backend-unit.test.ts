/**
 * B6 — OssBackend unit tests.
 *
 * Covers B6 C-01, C-02, C-03, C-04, C-05, C-06, C-07, C-08 in pure-logic mode
 * (no DB, no executor, no HTTP). Uses InProcessOssAdapter as a deterministic
 * test double so we can assert call records (branch propagation, deadline,
 * limit kinds).
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  ActionApplyForbiddenError,
  OssLimitExceededError,
  type OssCallContext,
} from "../../../src/services/quiver/compute/oss/ossPort";
import { InProcessOssAdapter } from "../../../src/services/quiver/compute/oss/inProcessOss";
import { OssBackend, buildOssBackends } from "../../../src/services/quiver/compute/oss/ossBackend";
import type { BackendExecuteInput, CardResult } from "../../../src/services/quiver/compute/types";

function input(over: Partial<BackendExecuteInput> & { cardType: string }): BackendExecuteInput {
  return {
    cardId: over.cardId ?? "card_a",
    cardType: over.cardType,
    config: over.config ?? {},
    upstreamResults: over.upstreamResults ?? new Map(),
    branch: over.branch ?? "trunk",
    parameterOverrides: over.parameterOverrides ?? {},
    remainingMs: over.remainingMs ?? 5_000,
    analysisRid: over.analysisRid ?? "ri.tellus-quiver.main.analysis.0190a000-0000-7000-8000-000000000001",
  };
}

function upstreamObjectSet(rid: string, branch = "trunk"): CardResult {
  return {
    cardId: "src",
    cardType: "OBJECT_SET",
    resultType: "OBJECT_SET",
    status: "OK",
    payload: {
      kind: "named",
      definition: { kind: "named", ontologyRid: "ri.tellus.ontology.main.default", objectSetRid: rid },
      estimatedRows: 100,
      storageGeneration: "OSv2",
    },
    contentHash: "hash-src",
    computedAtMs: Date.now(),
    cacheOutcome: "miss",
    ontologyVersion: "ontology@trunk",
    branch,
  };
}

describe("B6 — buildOssBackends", () => {
  it("B6 C-01: registers exactly the six OSS-bound card types", () => {
    const port = new InProcessOssAdapter();
    const backends = buildOssBackends(port);
    const types = backends.map((b) => b.cardType).sort();
    expect(types).toEqual(
      [
        "OBJECT_SET",
        "FILTER_OBJECT_SET",
        "SEARCH_AROUND",
        "AGGREGATION",
        "PROPERTY_VALUE_SELECT",
        "ACTION_BUTTON",
      ].sort(),
    );
    for (const b of backends) expect(b.backendName).toBe("OSS");
  });
});

describe("B6 — OBJECT_SET backend", () => {
  it("B6 C-02: createTemporaryObjectSet receives branch + remainingMs", async () => {
    const port = new InProcessOssAdapter();
    const backend = new OssBackend("OBJECT_SET", port);
    const out = await backend.execute(
      input({
        cardType: "OBJECT_SET",
        config: { ontologyRid: "ri.tellus.ontology.main.x", objectSetRid: "ri.tellus.os.main.y" },
        branch: "feature/foo",
        remainingMs: 1234,
      }),
    );
    expect(out.resultType).toBe("OBJECT_SET");
    expect((out.payload as any).temporaryRid).toMatch(/^tmp-/);
    const create = port.calls.find((c) => c.method === "createTemporaryObjectSet");
    expect(create).toBeDefined();
    expect(create!.branch).toBe("feature/foo");
    expect(create!.remainingMs).toBe(1234);
  });

  it("B6 C-03: OSv1 input over 100K → OssLimitExceededError(osv1_input)", async () => {
    const port = new InProcessOssAdapter({
      forcedStorageGeneration: "OSv1",
      forcedCardinality: 100_001,
    });
    const backend = new OssBackend("OBJECT_SET", port);
    await expect(backend.execute(input({ cardType: "OBJECT_SET" }))).rejects.toMatchObject({
      name: "OssLimitExceededError",
      kind: "osv1_input",
      limit: 100_000,
      observed: 100_001,
    });
  });

  it("B6 C-04: OSv2 result over 10M → OssLimitExceededError(osv2_result)", async () => {
    const port = new InProcessOssAdapter({
      forcedStorageGeneration: "OSv2",
      forcedCardinality: 10_000_001,
    });
    const backend = new OssBackend("OBJECT_SET", port);
    await expect(backend.execute(input({ cardType: "OBJECT_SET" }))).rejects.toMatchObject({
      name: "OssLimitExceededError",
      kind: "osv2_result",
      limit: 10_000_000,
    });
  });
});

describe("B6 — FILTER_OBJECT_SET backend", () => {
  it("propagates upstream definition + records branch", async () => {
    const port = new InProcessOssAdapter();
    const backend = new OssBackend("FILTER_OBJECT_SET", port);
    const upstream = new Map<string, CardResult>();
    upstream.set("src", upstreamObjectSet("ri.tellus.os.main.parent"));
    const out = await backend.execute(
      input({
        cardType: "FILTER_OBJECT_SET",
        upstreamResults: upstream,
        config: { predicate: { eq: { lhs: "status", rhs: "ACTIVE" } } },
        branch: "branch-q",
      }),
    );
    expect(out.resultType).toBe("OBJECT_SET");
    const def = (out.payload as any).definition;
    expect(def.kind).toBe("filter");
    expect(def.predicate).toEqual({ eq: { lhs: "status", rhs: "ACTIVE" } });
    expect(port.calls.every((c) => c.branch === "branch-q")).toBe(true);
  });
});

describe("B6 — SEARCH_AROUND backend", () => {
  it("B6 C-05: depth > 3 triggers OssLimitExceededError(search_around_depth)", async () => {
    const port = new InProcessOssAdapter();
    const backend = new OssBackend("SEARCH_AROUND", port);
    // Upstream already at depth 3.
    const deepUpstream: CardResult = {
      cardId: "src",
      cardType: "SEARCH_AROUND",
      resultType: "OBJECT_SET",
      status: "OK",
      payload: {
        definition: {
          kind: "searchAround",
          src: {
            kind: "searchAround",
            src: {
              kind: "searchAround",
              src: { kind: "named", ontologyRid: "x", objectSetRid: "y" },
              linkApiName: "L1",
            },
            linkApiName: "L2",
          },
          linkApiName: "L3",
        },
      },
      contentHash: "h",
      computedAtMs: Date.now(),
      cacheOutcome: "miss",
      ontologyVersion: "ontology@trunk",
      branch: "trunk",
    };
    const upstream = new Map<string, CardResult>();
    upstream.set("src", deepUpstream);
    await expect(
      backend.execute(
        input({
          cardType: "SEARCH_AROUND",
          upstreamResults: upstream,
          config: { linkApiName: "L4" },
        }),
      ),
    ).rejects.toMatchObject({
      name: "OssLimitExceededError",
      kind: "search_around_depth",
      depth: 4,
    });
  });

  it("depth 1 succeeds and records branch + remainingMs", async () => {
    const port = new InProcessOssAdapter();
    const backend = new OssBackend("SEARCH_AROUND", port);
    const upstream = new Map<string, CardResult>();
    upstream.set("src", upstreamObjectSet("ri.tellus.os.main.parent"));
    const out = await backend.execute(
      input({
        cardType: "SEARCH_AROUND",
        upstreamResults: upstream,
        config: { linkApiName: "links.refersTo" },
        branch: "main",
        remainingMs: 9_001,
      }),
    );
    expect(out.resultType).toBe("OBJECT_SET");
    const sa = port.calls.find((c) => c.method === "searchAround")!;
    expect(sa.branch).toBe("main");
    expect(sa.remainingMs).toBe(9_001);
  });
});

describe("B6 — AGGREGATION backend", () => {
  it("B6 C-06: default mode is PREFER_SPEED", async () => {
    const port = new InProcessOssAdapter();
    const backend = new OssBackend("AGGREGATION", port);
    const upstream = new Map<string, CardResult>();
    upstream.set("src", upstreamObjectSet("ri.tellus.os.main.parent"));
    await backend.execute(
      input({
        cardType: "AGGREGATION",
        upstreamResults: upstream,
        config: {
          groupBy: ["status"],
          aggregations: [{ alias: "n", property: "*", op: "COUNT" }],
        },
      }),
    );
    const agg = port.calls.find((c) => c.method === "aggregateObjectSet")!;
    expect(agg.args[3]).toBe("PREFER_SPEED");
  });

  it("B6 C-06: PREFER_ACCURACY only when explicitly opted in", async () => {
    const port = new InProcessOssAdapter();
    const backend = new OssBackend("AGGREGATION", port);
    const upstream = new Map<string, CardResult>();
    upstream.set("src", upstreamObjectSet("ri.tellus.os.main.parent"));
    await backend.execute(
      input({
        cardType: "AGGREGATION",
        upstreamResults: upstream,
        config: {
          groupBy: ["status"],
          aggregations: [{ alias: "n", property: "*", op: "COUNT" }],
          aggregation: { mode: "PREFER_ACCURACY" },
        },
      }),
    );
    const agg = port.calls.find((c) => c.method === "aggregateObjectSet")!;
    expect(agg.args[3]).toBe("PREFER_ACCURACY");
  });

  it("B6 C-07: result shape is TransformTable with declared column types", async () => {
    const port = new InProcessOssAdapter();
    const backend = new OssBackend("AGGREGATION", port);
    const upstream = new Map<string, CardResult>();
    upstream.set("src", upstreamObjectSet("ri.tellus.os.main.parent"));
    const out = await backend.execute(
      input({
        cardType: "AGGREGATION",
        upstreamResults: upstream,
        config: {
          groupBy: ["dept"],
          aggregations: [{ alias: "n", property: "*", op: "COUNT" }],
        },
      }),
    );
    expect(out.resultType).toBe("TRANSFORM_TABLE");
    const t = out.payload as any;
    expect(Array.isArray(t.columns)).toBe(true);
    for (const c of t.columns) expect(["STRING", "NUMBER", "BOOLEAN", "DATETIME"]).toContain(c.type);
    expect(Array.isArray(t.rows)).toBe(true);
  });

  it("rejects > 10 aggregations", async () => {
    const port = new InProcessOssAdapter();
    const backend = new OssBackend("AGGREGATION", port);
    const upstream = new Map<string, CardResult>();
    upstream.set("src", upstreamObjectSet("ri.tellus.os.main.parent"));
    const aggs = Array.from({ length: 11 }, (_, i) => ({
      alias: `a${i}`,
      property: "*",
      op: "COUNT" as const,
    }));
    await expect(
      backend.execute(
        input({
          cardType: "AGGREGATION",
          upstreamResults: upstream,
          config: { groupBy: [], aggregations: aggs },
        }),
      ),
    ).rejects.toMatchObject({ name: "OssLimitExceededError", kind: "aggregation_groups" });
  });
});

describe("B6 — ACTION_BUTTON backend", () => {
  it("B6 C-08: canApplyAction is consulted BEFORE applyAction", async () => {
    const port = new InProcessOssAdapter({
      permittedActions: new Set(["actions.allowed"]),
    });
    const backend = new OssBackend("ACTION_BUTTON", port);
    await expect(
      backend.execute(
        input({
          cardType: "ACTION_BUTTON",
          config: { actionApiName: "actions.denied" },
          parameterOverrides: { __user__: "alice@tellus" } as any,
        }),
      ),
    ).rejects.toBeInstanceOf(ActionApplyForbiddenError);
    // canApplyAction must have been called; applyAction must not.
    expect(port.calls.find((c) => c.method === "canApplyAction")).toBeDefined();
    expect(port.calls.find((c) => c.method === "applyAction")).toBeUndefined();
  });

  it("permitted action invocation succeeds and emits success outcome", async () => {
    const port = new InProcessOssAdapter({
      permittedActions: new Set(["actions.permitted"]),
    });
    const backend = new OssBackend("ACTION_BUTTON", port);
    const out = await backend.execute(
      input({
        cardType: "ACTION_BUTTON",
        config: { actionApiName: "actions.permitted", paramBindings: { x: 1 } },
        parameterOverrides: { __user__: "bob@tellus" } as any,
      }),
    );
    expect(out.resultType).toBe("TRANSFORM_TABLE");
    expect((out.payload as any).outcome).toBe("success");
  });
});

describe("B6 — branch propagation invariant", () => {
  beforeEach(() => {
    /* clean slate; test-local */
  });

  it("B6 C-09: every OSS call records the request branch", async () => {
    const port = new InProcessOssAdapter();
    const backend = new OssBackend("OBJECT_SET", port);
    await backend.execute(input({ cardType: "OBJECT_SET", branch: "branch-x" }));
    expect(port.calls.length).toBeGreaterThan(0);
    for (const c of port.calls) expect(c.branch).toBe("branch-x");
  });

  it("B6 C-09: a non-trunk branch is forwarded verbatim across multi-stage chains", async () => {
    const port = new InProcessOssAdapter();
    const upstream = new Map<string, CardResult>();
    upstream.set("src", upstreamObjectSet("ri.tellus.os.main.parent", "release/2026"));
    const backend = new OssBackend("AGGREGATION", port);
    await backend.execute(
      input({
        cardType: "AGGREGATION",
        upstreamResults: upstream,
        config: {
          groupBy: ["dept"],
          aggregations: [{ alias: "n", property: "*", op: "COUNT" }],
        },
        branch: "release/2026",
      }),
    );
    expect(port.calls.length).toBeGreaterThan(0);
    for (const c of port.calls) expect(c.branch).toBe("release/2026");
  });
});

describe("B6 — PROPERTY_VALUE_SELECT backend", () => {
  it("returns ARRAY_STRING with capped values", async () => {
    const port = new InProcessOssAdapter();
    const backend = new OssBackend("PROPERTY_VALUE_SELECT", port);
    const out = await backend.execute(
      input({
        cardType: "PROPERTY_VALUE_SELECT",
        config: { property: "category", topN: 1000 },
      }),
    );
    expect(out.resultType).toBe("ARRAY_STRING");
    expect((out.payload as any).truncated).toBe(true);
    expect((out.payload as any).values.length).toBe(100);
  });
});
