// ---------------------------------------------------------------------------
// Integration: Datasources + File Scanning (Tasks 5, 17, 18, 23, 24)
// ---------------------------------------------------------------------------

import fs from "fs";
import path from "path";
import { Runner } from "../../helpers/runner";
import { api } from "../../helpers/api";
import { TestContext } from "./context";

const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.resolve(__dirname, "../../..", "data");
const CSV_PATH = path.join(DATA_DIR, "test-employees.csv");

export { CSV_PATH };

export async function run(t: Runner, ctx: TestContext): Promise<void> {
  t.section("Datasources + File Scanning (Tasks 5, 17, 18, 23, 24)");

  await t.test("Create test CSV (Task 24)", async () => {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const departments = ["Engineering", "Sales", "HR"];
    const header = "emp_id,full_name,dept,salary,start_date,is_active,email,phone,age";
    const rows: string[] = [header];

    for (let i = 1; i <= 50; i++) {
      const empId = `E${String(i).padStart(3, "0")}`;
      const fullName = `Test Employee ${i}`;
      const dept = departments[i % 3];
      const salary = (30000 + Math.floor(Math.random() * 70001)).toFixed(2);
      const startDate = "2024-01-15";
      const isActive = i % 5 === 0 ? "false" : "true";
      const email = `emp${i}@test.com`;
      const phone = `+1555000${String(i).padStart(4, "0")}`;
      const age = 20 + (i % 40);
      rows.push(`${empId},${fullName},${dept},${salary},${startDate},${isActive},${email},${phone},${age}`);
    }

    fs.writeFileSync(CSV_PATH, rows.join("\n") + "\n", "utf-8");
    t.assert(fs.existsSync(CSV_PATH), "CSV file created");
    const lineCount = fs.readFileSync(CSV_PATH, "utf-8").trim().split("\n").length;
    t.assert(lineCount === 51, `Expected 51 lines, got ${lineCount}`);
  });

  await t.test("Register datasource with column mapping (Tasks 17, 23)", async () => {
    const { status, body } = await api(
      "POST",
      `/api/v1/ontology/${ctx.ontologyId}/objectTypes/Employee/datasource`,
      {
        datasetName: "Employee Dataset",
        filePath: CSV_PATH,
        fileFormat: "csv",
        columnMapping: {
          employeeId: "emp_id",
          fullName: "full_name",
          department: "dept",
          salary: "salary",
          startDate: "start_date",
          isActive: "is_active",
          email: "email",
          phone: "phone",
          age: "age",
        },
      }
    );
    t.assert(status === 201, `Expected 201, got ${status}`);
    t.assert(body.rowCount === 50, `rowCount = ${body.rowCount}`);
    t.assert(body.datasetName === "Employee Dataset", "datasetName matches");
    t.assert(body.fileFormat === "csv", "fileFormat = csv");
    t.assert(typeof body.schemaHash === "string", "schemaHash present");
    t.assert(Array.isArray(body.columnNames), "columnNames is array");
    t.assert(body.columnNames.length === 9, `Expected 9 cols, got ${body.columnNames.length}`);
    t.assert(typeof body.columnMapping === "object", "columnMapping present");
  });

  await t.test("Duplicate datasource fails (Task 17)", async () => {
    const { status, body } = await api(
      "POST",
      `/api/v1/ontology/${ctx.ontologyId}/objectTypes/Employee/datasource`,
      {
        datasetName: "Dup",
        filePath: CSV_PATH,
        fileFormat: "csv",
        columnMapping: { employeeId: "emp_id" },
      }
    );
    t.assert(status === 409, `Expected 409, got ${status}`);
    t.assert(body.error.code === "DATASOURCE_ALREADY_REGISTERED", `code = ${body.error.code}`);
  });

  await t.test("Bad column mapping rejected (Task 23)", async () => {
    const { status: createStatus } = await api(
      "POST",
      `/api/v1/ontology/${ctx.ontologyId}/objectTypes/batch`,
      {
        apiName: "TempWorker",
        displayName: "Temp Worker",
        properties: [
          { apiName: "workerId", displayName: "Worker ID", baseType: "string", isRequired: true },
        ],
        primaryKeyProperty: "workerId",
      }
    );
    t.assert(createStatus === 201, `Create TempWorker: expected 201, got ${createStatus}`);

    const tempCsvPath = path.join(DATA_DIR, "test-temp-workers.csv");
    fs.writeFileSync(tempCsvPath, "worker_id,name\n1,Alice\n2,Bob\n", "utf-8");

    const { status, body } = await api(
      "POST",
      `/api/v1/ontology/${ctx.ontologyId}/objectTypes/TempWorker/datasource`,
      {
        datasetName: "Bad Mapping DS",
        filePath: tempCsvPath,
        fileFormat: "csv",
        columnMapping: { nonExistentProp: "worker_id" },
      }
    );
    t.assert(status === 400, `Expected 400, got ${status}`);
    t.assert(body.error.code === "COLUMN_MAPPING_INVALID", `code = ${body.error.code}`);
    t.assert(body.error.message.includes("does not exist"), "mentions non-existent property");

    fs.unlinkSync(tempCsvPath);
    await api("DELETE", `/api/v1/ontology/${ctx.ontologyId}/objectTypes/TempWorker`);
  });

  await t.test("Get datasource (Task 18)", async () => {
    const { status, body } = await api(
      "GET",
      `/api/v1/ontology/${ctx.ontologyId}/objectTypes/Employee/datasource`
    );
    t.assert(status === 200, `Expected 200, got ${status}`);
    t.assert(body.datasetName === "Employee Dataset", "datasetName matches");
    t.assert(body.rowCount === 50, "rowCount = 50");
  });

  await t.test("Scan datasource (Task 24)", async () => {
    const { status, body } = await api(
      "POST",
      `/api/v1/ontology/${ctx.ontologyId}/objectTypes/Employee/datasource/scan`
    );
    t.assert(status === 200, `Expected 200, got ${status}`);
    t.assert(typeof body.schemaChanged === "boolean", "schemaChanged is boolean");
    t.assert(body.datasource !== undefined, "datasource present in response");
    t.assert(body.datasource.rowCount === 50, "rowCount still 50");
    t.assert(typeof body.datasource.lastScannedAt === "string", "lastScannedAt set");
  });
}
