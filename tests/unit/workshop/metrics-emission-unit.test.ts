// Unit tests for G-04 metrics wiring across B02/B07/B08/B10.
//
// Asserts the metric is *emitted* on the relevant code path — not just
// that the handle exists. The brief is explicit ("Tests assert that the
// expected metric is incremented and the expected structured log fields
// are emitted. The spec's metrics tables are part of the contract").
//
// We probe the prom-client default registry directly (the same mechanism
// `/metrics` uses), so this is exactly what scrapers see in prod.

import { describe, it, expect } from "vitest";
import * as promClient from "prom-client";

import "../../../src/services/workshop/metrics.js";
import { validateModule } from "../../../src/services/workshop/validator.js";
import { compileFilters } from "../../../src/services/workshop/filterCompiler.js";
import { aggregate } from "../../../src/services/workshop/aggregationService.js";
import { setOss } from "../../../src/services/workshop/ossAdapter.js";
import {
  validate as actionValidate,
  apply as actionApply,
} from "../../../src/services/workshop/actionApplyService.js";
import {
  setActions,
  StaleObjectError,
} from "../../../src/services/workshop/actionsAdapter.js";

const CTX = {
  jwt: "test.jwt",
  branchRid: null,
  userRid: "ri.multipass..user.u",
} as const;

async function metricCount(name: string): Promise<number> {
  const m = promClient.register.getSingleMetric(name);
  if (!m) return 0;
  const out = await m.get();
  let n = 0;
  for (const v of out.values) {
    if (typeof v.value === "number") n += v.value;
  }
  return n;
}

describe("G-04: metrics emission across B-tasks", () => {
  it("B02: validateModule increments tellus_workshop_validate_total", async () => {
    const before = await metricCount("tellus_workshop_validate_total");
    try {
      validateModule({});
    } catch {
      // expected: schema-invalid
    }
    const after = await metricCount("tellus_workshop_validate_total");
    expect(after).toBeGreaterThan(before);
  });

  it("B07: compileFilters observes tellus_workshop_filter_compile_seconds", async () => {
    const m = promClient.register.getSingleMetric(
      "tellus_workshop_filter_compile_seconds",
    );
    expect(m).toBeTruthy();
    compileFilters([], { properties: {} });
    const out = await m!.get();
    const countSample = out.values.find(
      (v) => v.metricName === "tellus_workshop_filter_compile_seconds_count",
    );
    expect(countSample?.value ?? 0).toBeGreaterThanOrEqual(1);
  });

  it("B08: aggregate increments groupby_kind counter for the chosen kind", async () => {
    setOss({
      load: async () => ({
        objects: [],
        nextPageToken: null,
        totalEstimate: 0,
      }),
      aggregate: async () => ({ buckets: [] }),
    });
    const before = await metricCount(
      "tellus_workshop_aggregate_groupby_kind_total",
    );
    await aggregate(
      {
        ontologyRid: "ri.ontology.main.ontology.x",
        objectTypeApiName: "Order",
        schema: { status: "string" },
        filters: [],
        aggregations: [
          {
            name: "byStatus",
            property: "status",
            groupBy: { kind: "exact" },
            aggregation: { kind: "count" },
          },
        ],
      },
      CTX,
    );
    const after = await metricCount(
      "tellus_workshop_aggregate_groupby_kind_total",
    );
    expect(after).toBe(before + 1);
  });

  it("B10: apply success increments tellus_workshop_apply_total", async () => {
    setActions({
      validate: async () => ({ valid: true, errors: [] }),
      apply: async () => ({
        validation: { valid: true, errors: [] },
        edits: {
          modifiedObjects: [],
          modifiedProperties: ["status"],
          createdObjects: [],
          deletedObjects: [],
        },
      }),
    });
    const before = await metricCount("tellus_workshop_apply_total");
    await actionApply(
      {
        ontologyRid: "ri.ontology.main.ontology.x",
        actionTypeApiName: "olivierAssignOrder",
        parameters: { assignee: "u" },
      },
      CTX,
    );
    const after = await metricCount("tellus_workshop_apply_total");
    expect(after).toBeGreaterThan(before);
  });

  it("B10: validate increments tellus_workshop_apply_total{phase=validate}", async () => {
    setActions({
      validate: async () => ({ valid: true, errors: [] }),
      apply: async () => ({
        validation: { valid: true, errors: [] },
        edits: {
          modifiedObjects: [],
          modifiedProperties: [],
          createdObjects: [],
          deletedObjects: [],
        },
      }),
    });
    const before = await metricCount("tellus_workshop_apply_total");
    await actionValidate(
      {
        ontologyRid: "ri.ontology.main.ontology.x",
        actionTypeApiName: "x",
        parameters: {},
      },
      CTX,
    );
    const after = await metricCount("tellus_workshop_apply_total");
    expect(after).toBeGreaterThan(before);
  });

  it("B10: stale object increments apply_stale_object_total", async () => {
    setActions({
      validate: async () => ({ valid: true, errors: [] }),
      apply: async () => {
        throw new StaleObjectError("Order", "1", "v1", "v2");
      },
    });
    const before = await metricCount(
      "tellus_workshop_apply_stale_object_total",
    );
    let surfaced = false;
    try {
      await actionApply(
        {
          ontologyRid: "ri.ontology.main.ontology.x",
          actionTypeApiName: "olivierAssignOrder",
          parameters: { assignee: "u" },
        },
        CTX,
      );
    } catch (e) {
      surfaced = true;
      expect((e as { errorName?: string }).errorName).toBe(
        "Tellus:Workshop:ActionStaleObject",
      );
    }
    expect(surfaced).toBe(true);
    const after = await metricCount(
      "tellus_workshop_apply_stale_object_total",
    );
    expect(after).toBe(before + 1);
  });
});
