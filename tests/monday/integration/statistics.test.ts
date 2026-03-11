// ---------------------------------------------------------------------------
// Integration: Statistics Endpoint (Task 25)
// ---------------------------------------------------------------------------

import { Runner } from "../../helpers/runner";
import { api } from "../../helpers/api";
import { TestContext } from "./context";

export async function run(t: Runner, ctx: TestContext): Promise<void> {
  t.section("Statistics (Task 25)");

  await t.test("Get statistics (Task 25)", async () => {
    const { status, body } = await api(
      "GET",
      `/api/v2/ontologies/${ctx.ontologyId}/objectTypes/Employee/statistics`
    );
    t.assert(status === 200, `Expected 200, got ${status}`);
    const stats = body.statistics;
    t.assert(stats.propertyCount === 10, `propertyCount = ${stats.propertyCount}`);
    t.assert(typeof stats.propertiesByType === "object", "propertiesByType is object");
    t.assert(stats.propertiesByType.string >= 1, "has string properties");
    t.assert(typeof stats.requiredPropertyCount === "number", "requiredPropertyCount present");
    t.assert(typeof stats.propertyCapacityUsed === "string", "propertyCapacityUsed is string");
    t.assert(stats.propertyCapacityUsed.endsWith("%"), "ends with %");
    t.assert(stats.datasource !== null, "datasource present");
    t.assert(stats.datasource.status === "registered", "datasource status = registered");
    t.assert(stats.datasource.rowCount === 50, "datasource rowCount = 50");
    t.assert(stats.indexing !== null, "indexing present");
    t.assert(stats.indexing.status === "not_indexed", "indexing status");
    t.assert(typeof stats.health === "string", "health is string");
  });
}
