// ---------------------------------------------------------------------------
// T-09 — full-text spec syntax unit tests.
//
// Covers contracts C-153 (spec-syntax detection triggers query_string),
// C-154 (allow_leading_wildcard:false), C-155 (lenient:true).
//
// We capture the OpenSearch body via spying on osClient.search and
// inspect the wrapped `bool.should` array.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  __resetMetricsForTesting,
  renderPrometheus,
} from "../../../src/services/funnel/metrics";

// Mock dependencies before importing the executor.
vi.mock("../../../src/services/propertyResolver", () => ({
  resolveProperty: vi.fn(),
  resolveAllProperties: vi.fn(async () => {
    return new Map([
      ["name", { baseType: "string", apiName: "name" }],
      ["bio", { baseType: "string", apiName: "bio" }],
    ]);
  }),
}));

vi.mock("../../../src/services/opensearch/indexLifecycleManager", () => ({
  getIndexName: (s: string) => `ontology-${s.toLowerCase()}`,
}));

vi.mock("../../../src/services/queryTranslator", () => ({
  translateFilter: vi.fn(async () => ({ match_all: {} })),
  buildSortClause: vi.fn(async () => []),
}));

import { client as osClient } from "../../../src/services/opensearch/client";
import { executeFullTextSearch } from "../../../src/services/queryExecutor";

function findQueryStringClause(body: any): any | undefined {
  // executeFullTextSearch wraps with injectSecurityFilter when
  // securityFilter is non-null. With null security and null branch the
  // body is returned unchanged so `body.query.bool.should` is the
  // top-level should array.
  const should = body?.query?.bool?.should;
  if (!Array.isArray(should)) return undefined;
  return should.find((c: any) => c.query_string !== undefined);
}

describe("T-09 executeFullTextSearch — spec syntax (C-153, C-154, C-155)", () => {
  let searchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    __resetMetricsForTesting();
    searchSpy = vi.spyOn(osClient as any, "search").mockResolvedValue({
      body: { hits: { hits: [], total: { value: 0 } } },
    });
  });
  afterEach(() => {
    searchSpy.mockRestore();
  });

  it("T-09 C-153a: bare 'yellow cab' (no spec syntax) → no query_string clause", async () => {
    await executeFullTextSearch("Driver", "yellow cab", { $pageSize: 10 }, null, null);
    const body = (searchSpy.mock.calls[0][0] as any).body;
    expect(findQueryStringClause(body)).toBeUndefined();
    const prom = renderPrometheus();
    expect(prom).toContain('tellus_full_text_spec_syntax_total{syntax_used="false"} 1');
  });

  it("T-09 C-153b: 'yellow AND cab' triggers a query_string clause", async () => {
    await executeFullTextSearch("Driver", "yellow AND cab", { $pageSize: 10 }, null, null);
    const body = (searchSpy.mock.calls[0][0] as any).body;
    const qs = findQueryStringClause(body);
    expect(qs).toBeDefined();
    expect(qs.query_string.query).toBe("yellow AND cab");
    expect(qs.query_string.default_operator).toBe("AND");
    const prom = renderPrometheus();
    expect(prom).toContain('tellus_full_text_spec_syntax_total{syntax_used="true"} 1');
  });

  it("T-09 C-153c: quoted phrase '\"yellow cab\"' triggers a query_string clause", async () => {
    await executeFullTextSearch("Driver", '"yellow cab"', { $pageSize: 10 }, null, null);
    const body = (searchSpy.mock.calls[0][0] as any).body;
    expect(findQueryStringClause(body)).toBeDefined();
  });

  it("T-09 C-153d: wildcard 'cab*' triggers a query_string clause", async () => {
    await executeFullTextSearch("Driver", "cab*", { $pageSize: 10 }, null, null);
    const body = (searchSpy.mock.calls[0][0] as any).body;
    expect(findQueryStringClause(body)).toBeDefined();
  });

  it("T-09 C-154/C-155: query_string clause hard-sets allow_leading_wildcard:false and lenient:true", async () => {
    await executeFullTextSearch("Driver", "yellow OR cab", { $pageSize: 10 }, null, null);
    const body = (searchSpy.mock.calls[0][0] as any).body;
    const qs = findQueryStringClause(body);
    expect(qs).toBeDefined();
    expect(qs.query_string.allow_leading_wildcard).toBe(false);
    expect(qs.query_string.lenient).toBe(true);
    expect(qs.query_string.analyze_wildcard).toBe(false); // env-gated default
  });
});
