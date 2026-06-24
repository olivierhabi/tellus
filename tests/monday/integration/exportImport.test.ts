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
      `/api/v1/ontology/${ctx.ontologyId}/export`
    );
    t.assert(status === 200, `Expected 200, got ${status}`);
    t.assert(body.exportVersion === "1.0", "exportVersion = 1.0");
    t.assert(typeof body.exportedAt === "string", "exportedAt present");
    t.assert(body.exportedFrom === "ontology-engine-v0.1.0", "exportedFrom");
    // Singleton deployment: the canonical ontology is shared and its
    // displayName is seed-dependent (and may be mutated by other tests), so
    // only assert it is a non-empty string. objectTypes is an array that
    // includes the Employee type created earlier in this suite.
    t.assert(typeof body.ontology.displayName === "string" && body.ontology.displayName.length > 0, "displayName present");
    t.assert(Array.isArray(body.ontology.objectTypes), "objectTypes is array");
    t.assert(body.ontology.objectTypes.length >= 1, "at least 1 object type");
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
      "/api/v1/ontology/import",
      ctx.exportData
    );
    // Singleton deployment: ontology import is frozen → 409 ONTOLOGY_SINGLETON.
    t.assert(status === 409, `Expected 409 (import frozen), got ${status}`);
    t.assert(body?.error?.code === "ONTOLOGY_SINGLETON", `code = ${body?.error?.code}`);
  });
}
