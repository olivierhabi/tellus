// ---------------------------------------------------------------------------
// Integration: Response Format, Error Handler, Property Guards (Tasks 9, 10, 15, 16)
// ---------------------------------------------------------------------------

import { Runner } from "../../helpers/runner";
import { api } from "../../helpers/api";
import { TestContext } from "./context";

export async function run(t: Runner, ctx: TestContext): Promise<void> {
  t.section("Response Format + Error Handler (Tasks 9, 10)");

  await t.test("Error response shape (Task 9)", async () => {
    const { body } = await api("GET", "/api/v1/ontologies/00000000-0000-0000-0000-000000000000");
    t.assert(body.error !== undefined, "error key present");
    t.assert(typeof body.error.code === "string", "error.code is string");
    t.assert(typeof body.error.message === "string", "error.message is string");
    t.assert(typeof body.error.details === "object", "error.details is object");
    t.assert(typeof body.error.timestamp === "string", "error.timestamp is string");
    const d = new Date(body.error.timestamp);
    t.assert(!isNaN(d.getTime()), "timestamp is valid ISO date");
  });

  await t.test("Error handler catches service errors (Task 10)", async () => {
    const { status, body } = await api(
      "GET",
      `/api/v1/ontologies/${ctx.ontologyId}/objectTypes/NonExistent`
    );
    t.assert(status === 404, `Expected 404, got ${status}`);
    t.assert(body.error.code === "OBJECT_TYPE_NOT_FOUND", `code = ${body.error.code}`);
  });

  t.section("Property Guards + Delete (Tasks 15, 16)");

  await t.test("Delete non-PK property (Task 15)", async () => {
    const { status } = await api(
      "DELETE",
      `/api/v1/ontologies/${ctx.ontologyId}/objectTypes/Employee/properties/phone`
    );
    t.assert(status === 204, `Expected 204, got ${status}`);
  });

  await t.test("Delete PK property fails (Task 15)", async () => {
    const { status, body } = await api(
      "DELETE",
      `/api/v1/ontologies/${ctx.ontologyId}/objectTypes/Employee/properties/employeeId`
    );
    t.assert(status === 400, `Expected 400, got ${status}`);
    t.assert(body.error.code === "VALIDATION_FAILED", `code = ${body.error.code}`);
    t.assert(body.error.message.includes("primary key"), "mentions primary key");
  });

  t.section("Updates (Tasks 14, 11/12)");

  await t.test("Update object type (Task 14)", async () => {
    const { status, body } = await api(
      "PUT",
      `/api/v1/ontologies/${ctx.ontologyId}/objectTypes/Employee`,
      { displayName: "Updated Employee", icon: "user", iconColor: "#FF0000" }
    );
    t.assert(status === 200, `Expected 200, got ${status}`);
    t.assert(body.objectType.displayName === "Updated Employee", "displayName updated");
    t.assert(body.objectType.icon === "user", "icon updated");
    t.assert(body.objectType.iconColor === "#FF0000", "iconColor updated");
  });

  await t.test("Update ontology (Task 11/12)", async () => {
    const { status, body } = await api(
      "PUT",
      `/api/v1/ontologies/${ctx.ontologyId}`,
      { displayName: "Test Ontology Updated", description: "Updated description" }
    );
    t.assert(status === 200, `Expected 200, got ${status}`);
    t.assert(body.displayName === "Test Ontology Updated", "displayName updated");
    t.assert(body.description === "Updated description", "description updated");
  });
}
