// ---------------------------------------------------------------------------
// Integration: Object Type CRUD + Batch (Tasks 3, 8, 13, 14, 26)
// ---------------------------------------------------------------------------

import { Runner } from "../../helpers/runner";
import { api } from "../../helpers/api";
import { TestContext } from "./context";

const batchBody = {
  apiName: "Employee",
  displayName: "Employee",
  properties: [
    { apiName: "employeeId", displayName: "Employee ID", baseType: "string", isRequired: true },
    { apiName: "fullName", displayName: "Full Name", baseType: "string", isRequired: true },
    { apiName: "department", displayName: "Department", baseType: "string" },
    { apiName: "salary", displayName: "Salary", baseType: "double" },
    { apiName: "startDate", displayName: "Start Date", baseType: "date" },
    { apiName: "isActive", displayName: "Is Active", baseType: "boolean" },
  ],
  primaryKeyProperty: "employeeId",
  titleProperty: "fullName",
};

export async function run(t: Runner, ctx: TestContext): Promise<void> {
  t.section("Object Types: CRUD + Batch (Tasks 3, 8, 13, 14, 26)");

  await t.test("Batch create OT with 6 properties (Tasks 3, 6, 26)", async () => {
    const { status, body } = await api(
      "POST",
      `/api/v1/ontology/${ctx.ontologyId}/objectTypes/batch`,
      batchBody
    );
    t.assert(status === 201, `Expected 201, got ${status}`);
    const ot = body.objectType;
    t.assert(ot.apiName === "Employee", "apiName = Employee");
    t.assert(ot.status === "experimental", "status = experimental");
    t.assert(ot.primaryKey === "employeeId", "PK set");
    t.assert(ot.titleProperty === "fullName", "title set");
    const propCount = Object.keys(ot.properties).length;
    t.assert(propCount === 6, `Expected 6 props, got ${propCount}`);
    t.assert(ot.indexingState !== null, "indexingState not null");
    t.assert(ot.indexingState.status === "not_indexed", "indexing status = not_indexed");
  });

  await t.test("Duplicate object type fails (Task 14)", async () => {
    const { status } = await api(
      "POST",
      `/api/v1/ontology/${ctx.ontologyId}/objectTypes/batch`,
      batchBody
    );
    t.assert(status === 409, `Expected 409, got ${status}`);
  });

  await t.test("Invalid apiName rejected (Task 8)", async () => {
    const { status, body } = await api(
      "POST",
      `/api/v1/ontology/${ctx.ontologyId}/objectTypes`,
      { apiName: "bad_name", displayName: "Bad" }
    );
    t.assert(status === 400, `Expected 400, got ${status}`);
    t.assert(body.error.code === "INVALID_API_NAME", `code = ${body.error.code}`);
  });

  await t.test("Reserved name rejected (Task 8)", async () => {
    const { status, body } = await api(
      "POST",
      `/api/v1/ontology/${ctx.ontologyId}/objectTypes`,
      { apiName: "Object", displayName: "Object" }
    );
    t.assert(status === 400, `Expected 400, got ${status}`);
    t.assert(body.error.code === "INVALID_API_NAME", `code = ${body.error.code}`);
    t.assert(body.error.message.includes("reserved"), "mentions reserved");
  });

  await t.test("List object types (Task 14)", async () => {
    const { status, body } = await api(
      "GET",
      `/api/v1/ontology/${ctx.ontologyId}/objectTypes`
    );
    t.assert(status === 200, `Expected 200, got ${status}`);
    // Singleton deployment: the canonical ontology is shared and may contain
    // other (seeded) object types. Locate the Employee type this suite
    // created rather than asserting the list length.
    const emp = (body.data || []).find((o: any) => o.apiName === "Employee");
    t.assert(!!emp, "Employee object type present in list");
    t.assert(emp.propertyCount === 6, "propertyCount = 6");
    t.assert(emp.indexStatus === "not_indexed", "indexStatus = not_indexed");
  });

  await t.test("Get object type with full details (Task 14)", async () => {
    const { status, body } = await api(
      "GET",
      `/api/v1/ontology/${ctx.ontologyId}/objectTypes/Employee`
    );
    t.assert(status === 200, `Expected 200, got ${status}`);
    t.assert(body.objectType.primaryKey === "employeeId", "PK = employeeId");
    t.assert(body.objectType.titleProperty === "fullName", "title = fullName");
  });
}
