// ---------------------------------------------------------------------------
// Integration: Cleanup — unregister, delete, verify cascades (Tasks 12, 14, 18)
// ---------------------------------------------------------------------------

import fs from "fs";
import { Runner } from "../../helpers/runner";
import { api } from "../../helpers/api";
import { TestContext } from "./context";
import { CSV_PATH } from "./datasource.test";

export async function run(t: Runner, ctx: TestContext): Promise<void> {
  t.section("Cleanup (Tasks 18, 14, 12)");

  await t.test("Unregister datasource (Task 18)", async () => {
    const { status } = await api(
      "DELETE",
      `/api/v2/ontologies/${ctx.ontologyId}/objectTypes/Employee/datasource`
    );
    t.assert(status === 204, `Expected 204, got ${status}`);

    const { status: getStatus } = await api(
      "GET",
      `/api/v2/ontologies/${ctx.ontologyId}/objectTypes/Employee/datasource`
    );
    t.assert(getStatus === 404, `Expected 404 after unregister, got ${getStatus}`);
  });

  await t.test("Delete object type + verify cascade (Tasks 3-6)", async () => {
    const { status } = await api(
      "DELETE",
      `/api/v2/ontologies/${ctx.ontologyId}/objectTypes/Employee`
    );
    t.assert(status === 204, `Expected 204, got ${status}`);

    const { status: getStatus } = await api(
      "GET",
      `/api/v2/ontologies/${ctx.ontologyId}/objectTypes/Employee`
    );
    t.assert(getStatus === 404, `Expected 404 after delete, got ${getStatus}`);
  });

  await t.test("Delete ontology (Task 12)", async () => {
    const { status } = await api("DELETE", `/api/v2/ontologies/${ctx.ontologyId}`);
    t.assert(status === 204, `Expected 204, got ${status}`);

    const { status: getStatus } = await api("GET", `/api/v2/ontologies/${ctx.ontologyId}`);
    t.assert(getStatus === 404, `Expected 404 after delete, got ${getStatus}`);
  });
}

// ---------------------------------------------------------------------------
// Post-suite cleanup — remove leftover test data
// ---------------------------------------------------------------------------

export async function cleanupLeftovers(): Promise<void> {
  try {
    const { body: listBody } = await api("GET", "/api/v2/ontologies");
    if (listBody && Array.isArray(listBody.data)) {
      for (const ont of listBody.data) {
        if (
          ont.displayName.includes("Test Ontology") ||
          ont.displayName.includes("(imported)")
        ) {
          await api("DELETE", `/api/v2/ontologies/${ont.ontologyId}`);
        }
      }
    }
  } catch {
    // Cleanup failures are not test failures
  }

  try {
    if (fs.existsSync(CSV_PATH)) {
      fs.unlinkSync(CSV_PATH);
    }
  } catch {
    // ignore
  }
}
