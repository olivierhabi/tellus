// ---------------------------------------------------------------------------
// Integration: Property CRUD + Validation (Tasks 4, 7, 15, 16, 22, 26)
// ---------------------------------------------------------------------------

import { Runner } from "../../helpers/runner";
import { api } from "../../helpers/api";
import { TestContext } from "./context";

export async function run(t: Runner, ctx: TestContext): Promise<void> {
  t.section("Properties: CRUD + Validation (Tasks 4, 7, 15, 16, 22, 26)");

  await t.test("Create single property (Task 15)", async () => {
    const { status, body } = await api(
      "POST",
      `/api/v2/ontologies/${ctx.ontologyId}/objectTypes/Employee/properties`,
      { apiName: "email", displayName: "Email", baseType: "string" }
    );
    t.assert(status === 201, `Expected 201, got ${status}`);
    t.assert(body.apiName === "email", "apiName = email");
    t.assert(body.baseType === "string", "baseType = string");
    t.assert(body.isRequired === false, "isRequired defaults to false");
    t.assert(body.isArray === false, "isArray = false");
  });

  await t.test("Invalid baseType rejected (Task 7)", async () => {
    const { status, body } = await api(
      "POST",
      `/api/v2/ontologies/${ctx.ontologyId}/objectTypes/Employee/properties`,
      { apiName: "bad", displayName: "Bad", baseType: "invalid" }
    );
    t.assert(status === 400, `Expected 400, got ${status}`);
    t.assert(body.error.code === "INVALID_BASE_TYPE", `code = ${body.error.code}`);
  });

  await t.test("Struct property with schema (Task 22)", async () => {
    const { status, body } = await api(
      "POST",
      `/api/v2/ontologies/${ctx.ontologyId}/objectTypes/Employee/properties`,
      {
        apiName: "address",
        displayName: "Address",
        baseType: "struct",
        structSchema: [
          { fieldName: "street", fieldType: "string" },
          { fieldName: "city", fieldType: "string" },
          { fieldName: "zipCode", fieldType: "string" },
        ],
      }
    );
    t.assert(status === 201, `Expected 201, got ${status}`);
    t.assert(body.baseType === "struct", "baseType = struct");
    t.assert(body.structSchema !== null, "structSchema not null");
    t.assert(Array.isArray(body.structSchema), "structSchema is array");
    t.assert(body.structSchema.length === 3, "3 struct fields");
  });

  await t.test("Invalid struct schema rejected (Task 22)", async () => {
    const { status, body } = await api(
      "POST",
      `/api/v2/ontologies/${ctx.ontologyId}/objectTypes/Employee/properties`,
      {
        apiName: "badStruct",
        displayName: "Bad Struct",
        baseType: "struct",
        structSchema: [
          { fieldName: "BadName", fieldType: "string" },
        ],
      }
    );
    t.assert(status === 400, `Expected 400, got ${status}`);
    t.assert(body.error.code === "VALIDATION_FAILED", `code = ${body.error.code}`);
    t.assert(body.error.message.includes("camelCase"), "mentions camelCase");
  });

  await t.test("structSchema on non-struct rejected (Task 22)", async () => {
    const { status, body } = await api(
      "POST",
      `/api/v2/ontologies/${ctx.ontologyId}/objectTypes/Employee/properties`,
      {
        apiName: "badProp",
        displayName: "Bad Prop",
        baseType: "string",
        structSchema: [{ fieldName: "x", fieldType: "string" }],
      }
    );
    t.assert(status === 400, `Expected 400, got ${status}`);
    t.assert(body.error.message.includes("struct"), "mentions struct");
  });

  await t.test("Property batch create (Task 26)", async () => {
    const { status, body } = await api(
      "POST",
      `/api/v2/ontologies/${ctx.ontologyId}/objectTypes/Employee/properties/batch`,
      {
        properties: [
          { apiName: "phone", displayName: "Phone", baseType: "string" },
          { apiName: "age", displayName: "Age", baseType: "integer" },
        ],
      }
    );
    t.assert(status === 201, `Expected 201, got ${status}`);
    t.assert(Array.isArray(body.data), "data is array");
    t.assert(body.data.length === 2, "2 properties created");
  });

  await t.test("List properties (Task 16)", async () => {
    const { status, body } = await api(
      "GET",
      `/api/v2/ontologies/${ctx.ontologyId}/objectTypes/Employee/properties`
    );
    t.assert(status === 200, `Expected 200, got ${status}`);
    t.assert(body.data.length === 10, `Expected 10 props, got ${body.data.length}`);
  });

  await t.test("Get single property (Task 16)", async () => {
    const { status, body } = await api(
      "GET",
      `/api/v2/ontologies/${ctx.ontologyId}/objectTypes/Employee/properties/email`
    );
    t.assert(status === 200, `Expected 200, got ${status}`);
    t.assert(body.apiName === "email", "apiName = email");
  });

  await t.test("Update property (Task 16)", async () => {
    const { status, body } = await api(
      "PUT",
      `/api/v2/ontologies/${ctx.ontologyId}/objectTypes/Employee/properties/email`,
      { displayName: "Work Email", isRequired: true }
    );
    t.assert(status === 200, `Expected 200, got ${status}`);
    t.assert(body.displayName === "Work Email", "displayName updated");
    t.assert(body.isRequired === true, "isRequired updated");
  });

  await t.test("Immutable field rejected on update (Task 16)", async () => {
    const { status, body } = await api(
      "PUT",
      `/api/v2/ontologies/${ctx.ontologyId}/objectTypes/Employee/properties/email`,
      { baseType: "integer" }
    );
    t.assert(status === 400, `Expected 400, got ${status}`);
    t.assert(body.error.code === "VALIDATION_FAILED", `code = ${body.error.code}`);
  });

  await t.test("Set primary key (Task 16)", async () => {
    const { status, body } = await api(
      "POST",
      `/api/v2/ontologies/${ctx.ontologyId}/objectTypes/Employee/primaryKey`,
      { propertyApiName: "employeeId" }
    );
    t.assert(status === 200, `Expected 200, got ${status}`);
    t.assert(body.message.includes("employeeId"), "message mentions employeeId");
  });

  await t.test("Set title property (Task 16)", async () => {
    const { status, body } = await api(
      "POST",
      `/api/v2/ontologies/${ctx.ontologyId}/objectTypes/Employee/titleProperty`,
      { propertyApiName: "fullName" }
    );
    t.assert(status === 200, `Expected 200, got ${status}`);
    t.assert(body.message.includes("fullName"), "message mentions fullName");
  });
}
