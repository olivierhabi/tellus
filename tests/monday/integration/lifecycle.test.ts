// ---------------------------------------------------------------------------
// Integration: Lifecycle — changeStatus, clone, export/import OT (Task 21)
// ---------------------------------------------------------------------------

import { Runner } from "../../helpers/runner";
import { api } from "../../helpers/api";
import { TestContext } from "./context";

export async function run(t: Runner, ctx: TestContext): Promise<void> {
  t.section("Lifecycle: changeStatus, clone, export/import OT (Task 21)");

  await t.test("changeStatus to experimental (Task 21)", async () => {
    const { status, body } = await api(
      "POST",
      `/api/v1/ontologies/${ctx.ontologyId}/objectTypes/Employee/changeStatus`,
      { status: "experimental" }
    );
    t.assert(status === 200, `Expected 200, got ${status}`);
    t.assert(body.objectType.status === "experimental", "status = experimental");
  });

  await t.test("changeStatus back to active (Task 21)", async () => {
    const { status, body } = await api(
      "POST",
      `/api/v1/ontologies/${ctx.ontologyId}/objectTypes/Employee/changeStatus`,
      { status: "active" }
    );
    t.assert(status === 200, `Expected 200, got ${status}`);
    t.assert(body.objectType.status === "active", "status = active");
  });

  await t.test("changeStatus invalid status (Task 21)", async () => {
    const { status, body } = await api(
      "POST",
      `/api/v1/ontologies/${ctx.ontologyId}/objectTypes/Employee/changeStatus`,
      { status: "invalid_status" }
    );
    t.assert(status === 400, `Expected 400, got ${status}`);
    t.assert(body.error.code === "VALIDATION_FAILED", `code = ${body.error.code}`);
  });

  await t.test("Clone object type (Task 21)", async () => {
    const { status, body } = await api(
      "POST",
      `/api/v1/ontologies/${ctx.ontologyId}/objectTypes/Employee/clone`,
      { newApiName: "EmployeeClone", newDisplayName: "Employee Clone" }
    );
    t.assert(status === 201, `Expected 201, got ${status}`);
    const ot = body.objectType;
    t.assert(ot.apiName === "EmployeeClone", "apiName = EmployeeClone");
    t.assert(ot.displayName === "Employee Clone", "displayName matches");
    t.assert(ot.status === "experimental", "clone status = experimental");
    const propCount = Object.keys(ot.properties).length;
    t.assert(propCount === 10, `Expected 10 cloned props, got ${propCount}`);
    t.assert(ot.primaryKey === "employeeId", "PK cloned");
    t.assert(ot.titleProperty === "fullName", "title cloned");
    t.assert(ot.backingDatasource === null, "no datasource on clone");
  });

  await t.test("Export single object type (Task 21)", async () => {
    const { status, body } = await api(
      "GET",
      `/api/v1/ontologies/${ctx.ontologyId}/objectTypes/Employee/export`
    );
    t.assert(status === 200, `Expected 200, got ${status}`);
    t.assert(body.exportVersion === "1.0", "exportVersion = 1.0");
    t.assert(typeof body.exportedAt === "string", "exportedAt present");
    t.assert(body.objectType.apiName === "Employee", "objectType.apiName = Employee");
    t.assert(Array.isArray(body.objectType.properties), "properties is array");
    t.assert(body.objectType.properties.length === 10, "10 properties exported");
    t.assert(body.objectType.primaryKeyProperty === "employeeId", "PK exported");
  });

  await t.test("Import single object type (Task 21)", async () => {
    const { body: exportBody } = await api(
      "GET",
      `/api/v1/ontologies/${ctx.ontologyId}/objectTypes/Employee/export`
    );
    exportBody.objectType.apiName = "EmployeeImported";
    exportBody.objectType.displayName = "Employee Imported";

    const { status, body } = await api(
      "POST",
      `/api/v1/ontologies/${ctx.ontologyId}/objectTypes/import`,
      exportBody
    );
    t.assert(status === 201, `Expected 201, got ${status}`);
    t.assert(body.objectType.apiName === "EmployeeImported", "imported apiName");
    const propCount = Object.keys(body.objectType.properties).length;
    t.assert(propCount === 10, `Expected 10 imported props, got ${propCount}`);
  });

  await t.test("Cleanup lifecycle OTs", async () => {
    const { status: del1 } = await api(
      "DELETE",
      `/api/v1/ontologies/${ctx.ontologyId}/objectTypes/EmployeeClone`
    );
    t.assert(del1 === 204, `Delete clone: expected 204, got ${del1}`);

    const { status: del2 } = await api(
      "DELETE",
      `/api/v1/ontologies/${ctx.ontologyId}/objectTypes/EmployeeImported`
    );
    t.assert(del2 === 204, `Delete imported: expected 204, got ${del2}`);
  });
}
