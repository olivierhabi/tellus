// Quiver F2 — state-contract surface (BE side of the FE Redux dispatch path).
//
// Coverage:
//   F2 C-10: every endpoint the FE dispatch path calls forwards
//            X-Tellus-Branch on the wire. The FE Redux store stamps
//            current branch on every dispatch; the BE accepts it via
//            X-Tellus-Branch header AND ?branch= query, both equally.
//   F2 C-04: optimistic dispatch is a UX concern; the BE-observable
//            contract is that PATCH responses include the new ETag so
//            the FE store can mark the card "saved" (same ETag the FE
//            sent on If-Match should be returned + 1).
//   G-05:    branch forwarding on every mutating call.

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { pool } from "../../../src/db";
import {
  applyQuiverMigrations,
  fakeCompass,
  quiverApp,
  teardownQuiverTables,
} from "./_harness";

const TEST_USER = "ri.multipass.main.user.f2";
const TEST_ORG = "ri.multipass.main.org.f2";
const FOLDER = "ri.compass.main.folder.f2";

function headers(extra: Record<string, string> = {}): Record<string, string> {
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

let compass: ReturnType<typeof fakeCompass>;
beforeEach(async () => {
  await teardownQuiverTables();
  compass?.detach();
  compass = fakeCompass();
});

describe("F2 C-10 — branch indicator stamps every dispatch", () => {
  it("F2 C-10: POST /analyses persists the branch from X-Tellus-Branch header", async () => {
    const app = quiverApp();
    const res = await request(app)
      .post("/quiver/api/v1/analyses")
      .set(headers({
        "idempotency-key": randomUUID(),
        "content-type": "application/json",
        "x-tellus-branch": "feature-redux-store",
      }))
      .send({ displayName: "F2 dispatch", parentFolderRid: FOLDER });
    expect(res.status).toBe(201);
    // The persisted row's branch is observable indirectly via the
    // listAnalysesInFolder filter, which is branch-scoped.
    const list = await request(app)
      .get(`/quiver/api/v1/folders/${encodeURIComponent(FOLDER)}/analyses`)
      .set(headers({ "x-tellus-branch": "feature-redux-store" }));
    expect(list.body.items.find((i: { rid: string }) => i.rid === res.body.rid)).toBeTruthy();
    // Different branch should NOT see this row.
    const otherList = await request(app)
      .get(`/quiver/api/v1/folders/${encodeURIComponent(FOLDER)}/analyses`)
      .set(headers({ "x-tellus-branch": "main" }));
    expect(otherList.body.items.find((i: { rid: string }) => i.rid === res.body.rid)).toBeFalsy();
  });

  it("F2 C-10: ?branch= query is equivalent to X-Tellus-Branch header (G-05)", async () => {
    const app = quiverApp();
    const created = await request(app)
      .post("/quiver/api/v1/analyses?branch=via-query")
      .set(headers({ "idempotency-key": randomUUID(), "content-type": "application/json" }))
      .send({ displayName: "via query", parentFolderRid: FOLDER });
    expect(created.status).toBe(201);
    const list = await request(app)
      .get(`/quiver/api/v1/folders/${encodeURIComponent(FOLDER)}/analyses?branch=via-query`)
      .set(headers());
    expect(list.body.items.find((i: { rid: string }) => i.rid === created.body.rid)).toBeTruthy();
  });
});

describe("F2 C-04 — PATCH returns new ETag for FE 'saved' indicator", () => {
  it("F2 C-04: PATCH responds with a new, different ETag than If-Match", async () => {
    const app = quiverApp();
    const created = await request(app)
      .post("/quiver/api/v1/analyses")
      .set(headers({ "idempotency-key": randomUUID(), "content-type": "application/json" }))
      .send({ displayName: "F2 etag", parentFolderRid: FOLDER });
    const initEtag = created.headers["etag"] as string;
    const patched = await request(app)
      .patch(`/quiver/api/v1/analyses/${encodeURIComponent(created.body.rid)}`)
      .set(headers({ "if-match": initEtag, "content-type": "application/json" }))
      .send({ displayName: "F2 etag updated" });
    expect(patched.status).toBe(200);
    expect(patched.headers["etag"]).toBeDefined();
    expect(patched.headers["etag"]).not.toBe(initEtag);
  });
});
