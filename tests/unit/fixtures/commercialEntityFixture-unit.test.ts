// ---------------------------------------------------------------------------
// Gap D — two-implementation fixture: pure-contract tests (offline).
//
// Proves the fixture's function signatures parse the way functionWebhookContract
// requires (compatible accepted, incompatible + stale handled correctly), the
// webhook I/O surfaces carry the typed shapes the binding validators expect,
// the implementer mappings satisfy the interfaceValidator gates, and the
// five required function labels + six webhook variants exist. These run
// offline under vitest.unit.config; the route-driven create/apply/cleanup is
// exercised by the integration test (requires the live server stack — Gap L).
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import {
  buildCommercialEntityFixture,
  classifyFunctionSignatures,
  assertFunctionContractsValid,
  assertWebhookShapesValid,
  assertFunctionsCovered,
  assertImplementerMappingsValid,
} from "../../fixtures/commercialEntityFixture";
import { parsePublishedFunctionType } from "../../../src/actions/functionWebhookContract";

const SUFFIX = "GapDUnit";

describe("commercialEntityFixture — spec build", () => {
  it("scopes every apiName under the singleton ontology by the suffix", () => {
    const spec = buildCommercialEntityFixture(SUFFIX, { controlledPort: 3329 });
    expect(spec.ontologyId).toBe("00000000-0000-0000-0000-000000000001");
    expect(spec.interface.apiName).toBe(`CommercialEntity${SUFFIX}`);
    expect(spec.implementers.map((i) => i.apiName)).toEqual([
      `CustomerAccount${SUFFIX}`,
      `SupplierAccount${SUFFIX}`,
      `IncompatibleAccount${SUFFIX}`,
    ]);
    for (const l of spec.links) expect(l.apiName.endsWith(SUFFIX)).toBe(true);
    for (const c of spec.interfaceLinkConstraints) expect(c.apiName.endsWith(SUFFIX)).toBe(true);
  });

  it("interface shared properties use only base_types allowed on interface_property", () => {
    const spec = buildCommercialEntityFixture(SUFFIX);
    const allowed = new Set([
      "string", "boolean", "integer", "long", "double", "float", "date", "timestamp",
      "byte", "short", "decimal", "geopoint", "geoshape",
      "string_array", "integer_array", "long_array", "double_array", "boolean_array", "timestamp_array",
      "struct",
    ]);
    for (const p of spec.interface.properties) {
      expect(allowed.has(p.baseType)).toBe(true);
    }
    // Attachment is NOT allowed on interface shared properties (per the BE map);
    // it is only a concrete-type property + a webhook input type.
    expect(spec.interface.properties.find((p) => p.apiName === "attachmentRef")).toBeUndefined();
  });

  it("two compatible implementers map every required interface property 1:1 with exact base_type", () => {
    const spec = buildCommercialEntityFixture(SUFFIX);
    assertImplementerMappingsValid(spec);
    const compatible = spec.implementers.filter((i) => !i.incompatible);
    expect(compatible).toHaveLength(2);
    for (const impl of compatible) {
      for (const ip of spec.interface.properties.filter((p) => p.isRequired)) {
        const mappedApi = impl.propertyMapping[ip.apiName];
        const concrete = impl.properties.find((p) => p.apiName === mappedApi);
        expect(concrete).toBeDefined();
        expect(concrete!.baseType).toBe(ip.baseType); // strict equality (no widening)
      }
    }
  });

  it("the incompatible implementer diverges on a shared property base_type", () => {
    const spec = buildCommercialEntityFixture(SUFFIX);
    const inc = spec.implementers.find((i) => i.incompatible)!;
    expect(inc.properties.find((p) => p.apiName === "status")!.baseType).toBe("boolean");
    expect(spec.interface.properties.find((p) => p.apiName === "status")!.baseType).toBe("string");
  });
});

describe("commercialEntityFixture — function contracts", () => {
  it("classifies the five function labels", () => {
    const spec = buildCommercialEntityFixture(SUFFIX);
    const v = classifyFunctionSignatures(spec);
    const byLabel = Object.fromEntries(v.map((x) => [x.label, x]));
    expect(byLabel["compatible-single"].parsed).toBe(true);
    expect(byLabel["compatible-single"].repeated).toBe(false);
    expect(byLabel["compatible-list"].parsed).toBe(true);
    expect(byLabel["compatible-list"].repeated).toBe(true);
    expect(byLabel["nullable"].parsed).toBe(true);
    expect(byLabel["incompatible"].parsed).toBe(false);
    expect(byLabel["stale-version"].parsed).toBe(true); // structurally fine; rejected by YANKED version
  });

  it("assertFunctionContractsValid passes for a well-formed fixture", () => {
    const spec = buildCommercialEntityFixture(SUFFIX);
    expect(() => assertFunctionContractsValid(spec)).not.toThrow();
  });

  it("assertFunctionsCovered requires all five labels", () => {
    const spec = buildCommercialEntityFixture(SUFFIX);
    assertFunctionsCovered(spec);
  });

  it("the single function parses as a record, not a list", () => {
    const single = buildCommercialEntityFixture(SUFFIX).functions.find((f) => f.label === "compatible-single")!;
    const parsed = parsePublishedFunctionType(single.signatureOutput);
    expect(parsed?.type?.kind).toBe("record");
  });
});

describe("commercialEntityFixture — webhook shapes", () => {
  it("every webhook targets the controlled service over http://localhost", () => {
    const spec = buildCommercialEntityFixture(SUFFIX, { controlledPort: 3329 });
    for (const w of spec.webhooks) {
      expect(w.endpointConfig.url.startsWith("http://localhost:3329")).toBe(true);
    }
    assertWebhookShapesValid(spec);
  });

  it("writeback webhooks carry a JSON object output_schema; side-effects carry null", () => {
    const spec = buildCommercialEntityFixture(SUFFIX);
    const writebacks = spec.webhooks.filter((w) => w.kind === "writeback");
    expect(writebacks.length).toBeGreaterThanOrEqual(1);
    for (const w of writebacks) {
      expect(w.outputSchema).not.toBeNull();
      expect((w.outputSchema as { type: string }).type).toBe("object");
    }
    for (const w of spec.webhooks.filter((x) => x.kind === "side-effect")) {
      expect(w.outputSchema).toBeNull();
    }
  });

  it("covers a writeback + at least two side-effects + nested/list/nullable/attachment input variants", () => {
    const spec = buildCommercialEntityFixture(SUFFIX);
    expect(spec.webhooks.filter((w) => w.kind === "writeback").length).toBeGreaterThanOrEqual(1);
    expect(spec.webhooks.filter((w) => w.kind === "side-effect").length).toBeGreaterThanOrEqual(2);
    const allSchemas = JSON.stringify(spec.webhooks.flatMap((w) => w.inputSchema));
    expect(allSchemas).toMatch(/array/); // list input
    expect(allSchemas).toMatch(/null/); // nullable input
    expect(allSchemas).toMatch(/attachment/); // attachment input
    expect(allSchemas).toMatch(/"object"/); // nested record input
  });
});
