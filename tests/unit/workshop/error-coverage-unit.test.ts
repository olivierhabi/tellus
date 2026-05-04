// Long-tail error code coverage — DoD: "Every listed error code is reachable
// from at least one test." Targets the four codes that no other test asserts:
//   Tellus:Workshop:ModuleVersionNotFound        (B03)
//   Tellus:Workshop:SemverTagImmutable           (B03)
//   Tellus:Workshop:UnsupportedFilterUiKind      (B07)
//   Tellus:Workshop:UnsupportedGroupByPropertyType (B08)

import { describe, expect, it } from "vitest";
import {
  moduleVersionNotFound,
  semverTagImmutable,
  unsupportedFilterUiKind,
} from "../../../src/services/workshop/errors";
import { compileFilters } from "../../../src/services/workshop/filterCompiler";

describe("Long-tail error coverage", () => {
  it("B03 ModuleVersionNotFound: factory produces 404 envelope", () => {
    const e = moduleVersionNotFound("ri.workshop.main.module.x", "9.9.9");
    const env = e.toEnvelope();
    expect(env.errorName).toBe("Tellus:Workshop:ModuleVersionNotFound");
    expect(env.errorCode).toBe("NOT_FOUND");
    expect(e.httpStatus).toBe(404);
    expect(env.parameters?.semver).toBe("9.9.9");
  });

  it("B03 SemverTagImmutable: factory produces 409 envelope", () => {
    const e = semverTagImmutable("ri.workshop.main.module.x", "1.0.0");
    const env = e.toEnvelope();
    expect(env.errorName).toBe("Tellus:Workshop:SemverTagImmutable");
    expect(env.errorCode).toBe("CONFLICT");
    expect(e.httpStatus).toBe(409);
  });

  it("B07 UnsupportedFilterUiKind: factory + reachable from compile path", () => {
    // Direct factory.
    const e = unsupportedFilterUiKind("nope-not-a-uiKind");
    expect(e.toEnvelope().errorName).toBe(
      "Tellus:Workshop:UnsupportedFilterUiKind",
    );
    expect(e.httpStatus).toBe(400);

    // Reachable from compileFilters() — feed an unknown uiKind.
    let caught: unknown = null;
    try {
      compileFilters(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        [{ uiKind: "totally-unknown" as any, property: "p", value: null }],
        { properties: { p: "string" } },
      );
    } catch (err) {
      caught = err;
    }
    expect((caught as { errorName?: string }).errorName).toBe(
      "Tellus:Workshop:UnsupportedFilterUiKind",
    );
  });

  it("B08 UnsupportedGroupByPropertyType: reachable via aggregate validateGroupBy", async () => {
    const { aggregate } = await import(
      "../../../src/services/workshop/aggregationService"
    );
    let caught: unknown = null;
    try {
      await aggregate(
        {
          ontologyRid: "ri.ontology.main.ontology.x",
          objectTypeApiName: "Order",
          schema: { status: "string" },
          filters: [],
          aggregations: [
            {
              name: "byStatus",
              chart: "pie",
              property: "status",
              groupBy: { kind: "fixedWidthBuckets" }, // numeric-only kind on string prop
              aggregation: { kind: "count" },
            },
          ],
        },
        { jwt: "j", branchRid: null, userRid: "u" },
      );
    } catch (err) {
      caught = err;
    }
    const e = caught as { errorName?: string; httpStatus?: number };
    expect(e?.errorName).toBe("Tellus:Workshop:UnsupportedGroupByPropertyType");
    expect(e?.httpStatus).toBe(400);
  });
});
