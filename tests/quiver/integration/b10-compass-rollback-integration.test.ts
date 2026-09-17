// B10 C-03 — Compass registration failure rolls back the dashboard publish.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { pool } from "../../../src/db";
import {
  applyQuiverMigrations,
  quiverApp,
  teardownQuiverTables,
} from "./_harness";
import {
  resetDashboardCompassPort,
  setDashboardCompassPort,
} from "../../../src/services/quiver/publishing/dashboardService";

const TEST_USER = "ri.multipass.main.user.alice";
const TEST_ORG = "ri.multipass.main.org.acme";
const ANALYSIS_RID = "ri.tellus-quiver.main.analysis.018f4a9c-7d6e-7c8a-87b0-0123456789ab";

function authedHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { "x-test-user": TEST_USER, "x-test-org": TEST_ORG, "X-Tellus-Test-Auth-Token": process.env.CODE_REPOS_TEST_AUTH_TOKEN ?? "", ...extra };
}

beforeAll(async () => {
  process.env.QUIVER_ALLOW_TEST_AUTH = "1";
  process.env.TELLUS_QUIVER_PHASE = "5";
  await applyQuiverMigrations();
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await teardownQuiverTables();
});

afterEach(() => {
  resetDashboardCompassPort();
});

async function seed(): Promise<void> {
  await pool.query(
    `INSERT INTO quiver_analysis
        (rid, parent_folder_rid, display_name, cards, canvases, parameters,
         current_version, etag, document_inline, markings, created_by, updated_by)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, 1, $7, $8::jsonb, $9, $10, $10)`,
    [
      ANALYSIS_RID,
      "ri.compass.main.folder.f1",
      "Test Analysis",
      JSON.stringify({
        $A: { id: "$A", type: "OBJECT_SET", inputs: {}, config: {}, hidden: false },
      }),
      JSON.stringify([{ id: "main", displayName: "Main", ordering: ["$A"] }]),
      JSON.stringify({}),
      "etag-seed-1",
      JSON.stringify({}),
      ["public"],
      TEST_USER,
    ],
  );
}

describe("B10 C-03: Compass registration failure rolls back publish", () => {
  it("publish returns 500 CompassRegistrationFailed and no dashboard row remains", async () => {
    await seed();
    setDashboardCompassPort({
      async resolveAnalysisParentFolder() {
        return "ri.compass.main.folder.f1";
      },
      async registerDashboard() {
        const e: Error & { code?: string } = new Error("compass down");
        e.code = "ETIMEDOUT";
        throw e;
      },
      async assertDashboardReadable() {},
      async assertEmbedTargetWritable() {},
    });
    const r = await request(quiverApp())
      .post("/quiver/api/v1/dashboards")
      .set(authedHeaders({ "idempotency-key": randomUUID() }))
      .send({
        analysisRid: ANALYSIS_RID,
        displayName: "Will fail",
        exposedCanvases: ["main"],
        parameterSchema: { type: "object", properties: {}, required: [] },
      });
    expect(r.status).toBe(500);
    expect(r.body.errorName).toBe("Tellus:Quiver:CompassRegistrationFailed");
    const after = await pool.query(`SELECT count(*)::int AS n FROM quiver_dashboard`);
    expect(after.rows[0].n).toBe(0);
  });
});
