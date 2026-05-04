// Quiver F1 — auth contract surface (BE side of the FE 401 → multipass redirect).
//
// Coverage:
//   F1 C-02: every Quiver endpoint returns 401 Tellus:Quiver:Unauthenticated
//            on missing/invalid token. The FE observes this status code and
//            routes the user to /multipass/api/oauth2/authorize.
//   F1 C-08: cypress smoke exercises the same surface (see cypress/quiver/e2e/F1.cy.ts).
//   G-01:    auth required at every resource boundary.

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import request from "supertest";
import { pool } from "../../../src/db";
import {
  applyQuiverMigrations,
  fakeCompass,
  quiverApp,
  teardownQuiverTables,
} from "./_harness";

beforeAll(async () => {
  process.env.QUIVER_ALLOW_TEST_AUTH = "1";
  process.env.TELLUS_QUIVER_PHASE = "5";
  await applyQuiverMigrations();
});

afterAll(async () => {
  await pool.end();
});

let compass: ReturnType<typeof fakeCompass>;

beforeEach(async () => {
  await teardownQuiverTables();
  compass?.detach();
  compass = fakeCompass();
});

const FAKE_RID = "ri.tellus-quiver.main.analysis.00000000-0000-7000-8000-000000000001";
const FAKE_FOLDER = "ri.compass.main.folder.f1";

describe("F1 C-02 — every endpoint returns 401 Tellus:Quiver:Unauthenticated without auth", () => {
  const cases: Array<[string, "get" | "post" | "patch" | "put" | "delete", string]> = [
    ["POST /analyses", "post", `/quiver/api/v1/analyses`],
    ["GET /analyses/:rid", "get", `/quiver/api/v1/analyses/${encodeURIComponent(FAKE_RID)}`],
    ["PATCH /analyses/:rid", "patch", `/quiver/api/v1/analyses/${encodeURIComponent(FAKE_RID)}`],
    ["DELETE /analyses/:rid", "delete", `/quiver/api/v1/analyses/${encodeURIComponent(FAKE_RID)}`],
    ["GET /folders/:folderRid/analyses", "get", `/quiver/api/v1/folders/${encodeURIComponent(FAKE_FOLDER)}/analyses`],
    ["POST /analyses/:rid/_validate", "post", `/quiver/api/v1/analyses/${encodeURIComponent(FAKE_RID)}/_validate`],
    ["POST /analyses/:rid/versions", "post", `/quiver/api/v1/analyses/${encodeURIComponent(FAKE_RID)}/versions`],
    ["GET /analyses/:rid/versions", "get", `/quiver/api/v1/analyses/${encodeURIComponent(FAKE_RID)}/versions`],
    ["GET /analyses/:rid/versions/:v", "get", `/quiver/api/v1/analyses/${encodeURIComponent(FAKE_RID)}/versions/1`],
    ["POST /analyses/:rid/versions/:v:revert", "post", `/quiver/api/v1/analyses/${encodeURIComponent(FAKE_RID)}/versions/1:revert`],
    ["POST /analyses/:rid/working-states", "post", `/quiver/api/v1/analyses/${encodeURIComponent(FAKE_RID)}/working-states`],
    ["GET /analyses/:rid/working-states/:sid", "get", `/quiver/api/v1/analyses/${encodeURIComponent(FAKE_RID)}/working-states/0000000000`],
    ["PUT /analyses/:rid/working-states/:sid", "put", `/quiver/api/v1/analyses/${encodeURIComponent(FAKE_RID)}/working-states/0000000000`],
  ];

  for (const [name, method, path] of cases) {
    it(`F1 C-02 [${name}]: returns 401 + Tellus:Quiver:Unauthenticated`, async () => {
      const app = quiverApp();
      const r = await (request(app) as never as Record<string, (p: string) => { send: (b?: unknown) => Promise<{ status: number; body: { errorName?: string } }> }>)[
        method
      ](path).send(method === "patch" || method === "put" ? {} : undefined);
      expect(r.status).toBe(401);
      expect(r.body.errorName).toBe("Tellus:Quiver:Unauthenticated");
    });
  }
});

describe("F1 C-08 — login → API contract surface", () => {
  it("F1 C-08: with valid test auth (substituting Multipass), POST /analyses returns 201", async () => {
    const app = quiverApp();
    const r = await request(app)
      .post(`/quiver/api/v1/analyses`)
      .set({
        "x-test-user": "ri.multipass.main.user.f1",
        "x-test-org": "ri.multipass.main.org.f1",
        "idempotency-key": "00000000-0000-7000-8000-000000f10081",
        "content-type": "application/json",
      })
      .send({ displayName: "F1 smoke", parentFolderRid: FAKE_FOLDER });
    expect(r.status).toBe(201);
  });
});
