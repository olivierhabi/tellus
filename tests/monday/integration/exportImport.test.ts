// ---------------------------------------------------------------------------
// Integration: Ontology Export/Import (Task 28)
// ---------------------------------------------------------------------------

import { Runner } from "../../helpers/runner";
import { api } from "../../helpers/api";
import { TestContext } from "./context";

export async function run(t: Runner, ctx: TestContext): Promise<void> {
  t.section("Ontology Export/Import (Task 28)");

  await t.test("Export full ontology (Task 28)", async () => {
    const { status, body, headers } = await api(
      "GET",
      `/api/v2/ontologies/${ctx.ontologyId}/export`
    );
    t.assert(status === 200, `Expected 200, got ${status}`);
    t.assert(body.exportVersion === "1.0", "exportVersion = 1.0");
    t.assert(typeof body.exportedAt === "string", "exportedAt present");
    t.assert(body.exportedFrom === "ontology-engine-v0.1.0", "exportedFrom");
    t.assert(body.ontology.displayName === "Test Ontology", "displayName");
    t.assert(Array.isArray(body.ontology.objectTypes), "objectTypes is array");
    t.assert(body.ontology.objectTypes.length === 1, "1 object type");
    t.assert(Array.isArray(body.ontology.linkTypes), "linkTypes array present");
    t.assert(Array.isArray(body.ontology.actionTypes), "actionTypes array present");

    const cd = headers.get("content-disposition");
    t.assert(cd !== null && cd.includes(".json"), `Content-Disposition: "${cd}"`);

    ctx.exportData = body;
  });

  await t.test("Import full ontology (Task 28)", async () => {
    t.assert(ctx.exportData !== null, "Export data from previous test");

    const { status, body } = await api(
      "POST",
      "/api/v2/ontologies/import",
      ctx.exportData
    );
    t.assert(status === 201, `Expected 201, got ${status}`);
    t.assert(typeof body.ontologyId === "string", "new ontologyId");
    t.assert(body.objectTypeCount === 1, `objectTypeCount = ${body.objectTypeCount}`);
    t.assert(
      body.displayName.includes("Test Ontology"),
      `displayName includes original: "${body.displayName}"`
    );
  });
}
