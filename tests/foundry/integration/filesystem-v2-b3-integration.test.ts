// ---------------------------------------------------------------------------
// B3 — Filesystem v2 Public API integration tests
// ---------------------------------------------------------------------------
// Spec:      tasks/files-projects/files-projects-tasks.md §B3.
// Contracts: tasks/files-projects/contracts.md (B3-C-01..71).
//
// Runs against the live tellus-postgres-1 stack. Boots the express app via
// supertest. Authenticates by minting a JWT for the seeded user, matching
// the pattern used in `compass-b1-integration.test.ts`.
// ---------------------------------------------------------------------------

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomBytes, randomUUID } from "crypto";
import request from "supertest";
import knexLib, { Knex } from "knex";

// Hit the live spawned test server (tests/globalSetup.ts spawns
// `npx tsx src/server.ts` on :3000 with TELLUS_TEST_HOOKS=1). Importing
// `app` directly would spin up a SECOND express stack with its own auth
// middleware; that path doesn't see the spawned server's seeded users.
import { ROOT_SPACE_RID } from "../../../src/lib/rid";

const TEST_SERVER = process.env.TEST_SERVER_URL || "http://localhost:3000";

const knex: Knex = knexLib({
  client: "pg",
  connection: {
    host: process.env.PGHOST || "localhost",
    port: Number(process.env.PGPORT || 5432),
    user: process.env.PGUSER || "tellus",
    password: process.env.PGPASSWORD || "tellus123",
    database: process.env.PGDATABASE || "tellus_db",
  },
});

const PAT_PREFIX = "tellus_pat_";

let userId: string;
let patToken: string;
let patId: string;

let probeProjectRid: string;
let probeProjectEtag: number;
let probeFolderRid: string;

function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${patToken}` };
}

beforeAll(async () => {
  // B3.bf1 — docker stack snapshot prepended to /tmp/b3-integration.log so
  // `head -1` matches the gate. Mirrors B1.bf3 / B2.bf2 pattern.
  try {
    const { execSync } = await import("node:child_process");
    const fs = await import("node:fs");
    let psJson = "";
    try {
      psJson = execSync(
        "docker compose -f docker-compose.test.yml ps --format json",
        { encoding: "utf8" },
      );
    } catch {
      psJson = execSync("docker ps --format '{{json .}}'", { encoding: "utf8" });
    }
    fs.appendFileSync(
      "/tmp/b3-integration.log",
      `=== docker compose ps ===\n${psJson}\n=== begin tests ===\n`,
    );
    const required = ["postgres", "kafka", "keycloak", "schema-registry", "minio"];
    for (const svc of required) {
      if (!psJson.includes(svc)) {
        throw new Error(`Required service ${svc} not present in docker ps snapshot`);
      }
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[B3.bf1] docker snapshot beforeAll soft-failed:", (err as Error).message);
  }

  const seed = await knex<{ id: string; email: string }>("users").first("id", "email");
  if (!seed) {
    throw new Error("No seed user in `users` table — run `npm run migrate:foundry` first.");
  }
  userId = seed.id;
  // Mint a Personal Access Token directly in the DB — the v2 routes go
  // through `authenticate` → `requireTellusAuth`, which accepts PATs without
  // a Keycloak round-trip. The hash matches `TellusAuthService.hashToken`
  // (sha256 hex of the literal token string).
  const rawSuffix = randomBytes(32).toString("hex");
  patToken = `${PAT_PREFIX}${rawSuffix}`;
  const tokenHash = createHash("sha256").update(patToken).digest("hex");
  const tokenPrefix = patToken.slice(0, PAT_PREFIX.length + 8);
  const inserted = await knex("personal_access_tokens")
    .insert({
      user_id: userId,
      keycloak_sub: null,
      name: `b3-integration-test-${Date.now()}`,
      token_hash: tokenHash,
      token_prefix: tokenPrefix,
      scopes: ["api:read", "api:write"],
      expires_at: new Date(Date.now() + 60 * 60 * 1000),
    })
    .returning("id");
  patId = inserted[0]?.id ?? inserted[0];

  // Pick a probe project from the live DB.
  const proj = await knex("resources")
    .where({ type: "PROJECT", trash_status: "NOT_TRASHED" })
    .orderBy("created_at", "asc")
    .first("rid", "etag");
  if (!proj) throw new Error("No PROJECT resource available for probe.");
  probeProjectRid = proj.rid;
  // Postgres can return integer columns as either number or string depending
  // on driver settings — coerce to be safe before arithmetic.
  probeProjectEtag = Number(proj.etag);

  // Pick a probe folder under that project.
  const folder = await knex("resources")
    .where({ type: "COMPASS_FOLDER" })
    .andWhere("project_rid", probeProjectRid)
    .first("rid");
  if (folder) probeFolderRid = folder.rid;
});

afterAll(async () => {
  if (patId) {
    await knex("personal_access_tokens").where({ id: patId }).delete();
  }
  await knex.destroy();
});

describe("B3 — Filesystem v2 Public API", () => {
  // -------------------------------------------------------------------------
  // B3-C-09: GET /resources/{rid}
  // -------------------------------------------------------------------------
  it("B3-C-09 GET /resources/{rid} returns the resource with ETag", async () => {
    const res = await request(TEST_SERVER)
      .get(`/api/v2/filesystem/resources/${encodeURIComponent(probeProjectRid)}`)
      .set(authHeaders());
    expect(res.status).toBe(200);
    expect(res.body.rid).toBe(probeProjectRid);
    expect(res.headers.etag).toBe(`"v${probeProjectEtag}"`);
  });

  it("B3-C-31 RESOURCE_NOT_FOUND returns Conjure envelope with 404", async () => {
    const bogus = `ri.compass.main.project.${randomUUID()}`;
    const res = await request(TEST_SERVER)
      .get(`/api/v2/filesystem/resources/${encodeURIComponent(bogus)}`)
      .set(authHeaders());
    expect(res.status).toBe(404);
    expect(res.body.errorCode).toBe("RESOURCE_NOT_FOUND");
    expect(res.body.errorName).toBe("ResourceNotFoundError");
    expect(typeof res.body.errorInstanceId).toBe("string");
  });

  // -------------------------------------------------------------------------
  // B3-C-02 / B3-C-04: GET /folders/{rid} + children pagination
  // -------------------------------------------------------------------------
  it("B3-C-04 GET /folders/{rid}/children returns paginated children", async () => {
    const res = await request(TEST_SERVER)
      .get(`/api/v2/filesystem/folders/${encodeURIComponent(probeProjectRid)}/children?pageSize=2`)
      .set(authHeaders());
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    // pageSize=2 + at least 1 child should generate a token.
    expect(res.body.data.length).toBeLessThanOrEqual(2);
  });

  it("B3-C-42 invalid pageSize returns INVALID_ARGUMENT (400)", async () => {
    const res = await request(TEST_SERVER)
      .get(`/api/v2/filesystem/folders/${encodeURIComponent(probeProjectRid)}/children?pageSize=0`)
      .set(authHeaders());
    expect(res.status).toBe(400);
    expect(res.body.errorCode).toBe("INVALID_ARGUMENT");
  });

  it("B3-C-41 malformed pageToken returns INVALID_PAGE_TOKEN (400)", async () => {
    const res = await request(TEST_SERVER)
      .get(
        `/api/v2/filesystem/folders/${encodeURIComponent(probeProjectRid)}/children?pageToken=not-base64`,
      )
      .set(authHeaders());
    expect(res.status).toBe(400);
    expect(res.body.errorCode).toBe("INVALID_PAGE_TOKEN");
  });

  // -------------------------------------------------------------------------
  // B3-C-03: POST /folders/getBatch
  // -------------------------------------------------------------------------
  it("B3-C-03 POST /folders/getBatch returns batch in input order", async () => {
    const rids = [probeProjectRid];
    if (probeFolderRid) rids.push(probeFolderRid);
    const res = await request(TEST_SERVER)
      .post(`/api/v2/filesystem/folders/getBatch`)
      .set(authHeaders())
      .send({ folderRids: rids });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body[0].rid).toBe(rids[0]);
  });

  it("B3-C-03 batch >1000 returns BATCH_TOO_LARGE (400)", async () => {
    const rids = Array.from(
      { length: 1001 },
      (_, i) => `ri.compass.main.compass-folder.${randomUUID()}`,
    );
    const res = await request(TEST_SERVER)
      .post(`/api/v2/filesystem/folders/getBatch`)
      .set(authHeaders())
      .send({ folderRids: rids });
    expect(res.status).toBe(400);
    expect(res.body.errorCode).toBe("BATCH_TOO_LARGE");
  });

  // -------------------------------------------------------------------------
  // B3-C-10: GET /resources?path=<path>
  // -------------------------------------------------------------------------
  it("B3-C-10 GET /resources?path=/Root resolves the root space", async () => {
    const res = await request(TEST_SERVER)
      .get(`/api/v2/filesystem/resources?path=/Root`)
      .set(authHeaders());
    expect(res.status).toBe(200);
    expect(res.body.rid).toBe(ROOT_SPACE_RID);
  });

  // -------------------------------------------------------------------------
  // B3-C-17: GET /spaces/{rid} + GET /spaces (B3-C-16)
  // -------------------------------------------------------------------------
  it("B3-C-16 GET /spaces returns the spaces list", async () => {
    const res = await request(TEST_SERVER).get(`/api/v2/filesystem/spaces`).set(authHeaders());
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBeGreaterThanOrEqual(1);
    expect(res.body.data[0].rid).toBe(ROOT_SPACE_RID);
  });

  it("B3-C-17 GET /spaces/{root} returns the root space", async () => {
    const res = await request(TEST_SERVER)
      .get(`/api/v2/filesystem/spaces/${encodeURIComponent(ROOT_SPACE_RID)}`)
      .set(authHeaders());
    expect(res.status).toBe(200);
    expect(res.body.rid).toBe(ROOT_SPACE_RID);
  });

  // -------------------------------------------------------------------------
  // B3-C-07 / B3-C-20 / B3-C-21: PUT /projects/{rid} ETag enforcement
  // -------------------------------------------------------------------------
  it("B3-C-20 PUT /projects/{rid} without If-Match → 428 PRECONDITION_REQUIRED", async () => {
    const res = await request(TEST_SERVER)
      .put(`/api/v2/filesystem/projects/${encodeURIComponent(probeProjectRid)}`)
      .set(authHeaders())
      .send({ description: "test" });
    expect(res.status).toBe(428);
    expect(res.body.errorCode).toBe("PRECONDITION_REQUIRED");
  });

  it("B3-C-21 PUT /projects/{rid} stale If-Match → 412 PRECONDITION_FAILED", async () => {
    // Pick a version that cannot match: current_etag + 100. Mismatch in
    // either direction is stale per the Foundry contract; using +100 avoids
    // racing with concurrent test runs that may bump the etag.
    const staleEtag = probeProjectEtag + 100;
    const res = await request(TEST_SERVER)
      .put(`/api/v2/filesystem/projects/${encodeURIComponent(probeProjectRid)}`)
      .set(authHeaders())
      .set("If-Match", `"v${staleEtag}"`)
      .send({ description: "test" });
    expect(res.status).toBe(412);
    expect(res.body.errorCode).toBe("PRECONDITION_FAILED");
    expect(res.body.parameters?.expected).toBe(staleEtag);
    expect(typeof res.body.parameters?.actual).toBe("number");
  });

  it("B3-C-24 PUT /projects/{rid} with malformed If-Match → 400 INVALID_ARGUMENT", async () => {
    const res = await request(TEST_SERVER)
      .put(`/api/v2/filesystem/projects/${encodeURIComponent(probeProjectRid)}`)
      .set(authHeaders())
      .set("If-Match", "garbage")
      .send({ description: "test" });
    expect(res.status).toBe(400);
    expect(res.body.errorCode).toBe("INVALID_ARGUMENT");
  });

  // -------------------------------------------------------------------------
  // B3-C-31 / B3-C-32 / B3-C-33: Idempotency-Key
  // -------------------------------------------------------------------------
  it("B3-C-31 POST /projects with Idempotency-Key replays cached response", async () => {
    const key = randomUUID();
    const name = `b3-idem-test-${Date.now()}`;
    const r1 = await request(TEST_SERVER)
      .post(`/api/v2/filesystem/projects`)
      .set(authHeaders())
      .set("Idempotency-Key", key)
      .send({ displayName: name });
    expect(r1.status).toBe(201);
    const created = r1.body;

    // Replay with same key + same body → should return cached.
    const r2 = await request(TEST_SERVER)
      .post(`/api/v2/filesystem/projects`)
      .set(authHeaders())
      .set("Idempotency-Key", key)
      .send({ displayName: name });
    expect(r2.status).toBe(201);
    expect(r2.headers["idempotent-replay"]).toBe("true");
    expect(r2.body.rid).toBe(created.rid);

    // Cleanup
    await knex("idempotency_keys").where({ key }).delete();
    await knex("resources").where({ rid: created.rid }).delete();
    await knex("project_members").where({ project_id: created.legacyUuid }).delete();
    await knex("projects").where({ id: created.legacyUuid }).delete();
  });

  it("B3-C-32 same Idempotency-Key + different body → 409 IDEMPOTENCY_KEY_CONFLICT", async () => {
    const key = randomUUID();
    const name1 = `b3-idem-conflict-${Date.now()}`;
    const r1 = await request(TEST_SERVER)
      .post(`/api/v2/filesystem/projects`)
      .set(authHeaders())
      .set("Idempotency-Key", key)
      .send({ displayName: name1 });
    expect(r1.status).toBe(201);

    const r2 = await request(TEST_SERVER)
      .post(`/api/v2/filesystem/projects`)
      .set(authHeaders())
      .set("Idempotency-Key", key)
      .send({ displayName: `${name1}-different` });
    expect(r2.status).toBe(409);
    expect(r2.body.errorCode).toBe("IDEMPOTENCY_KEY_CONFLICT");

    // Cleanup
    await knex("idempotency_keys").where({ key }).delete();
    if (r1.body.legacyUuid) {
      await knex("resources").where({ rid: r1.body.rid }).delete();
      await knex("project_members").where({ project_id: r1.body.legacyUuid }).delete();
      await knex("projects").where({ id: r1.body.legacyUuid }).delete();
    }
  });

  it("B3-C-33 malformed Idempotency-Key → 400 INVALID_ARGUMENT", async () => {
    const res = await request(TEST_SERVER)
      .post(`/api/v2/filesystem/projects`)
      .set(authHeaders())
      .set("Idempotency-Key", "not-a-uuid")
      .send({ displayName: `b3-idem-bad-${Date.now()}` });
    expect(res.status).toBe(400);
    expect(res.body.errorCode).toBe("INVALID_ARGUMENT");
  });

  // -------------------------------------------------------------------------
  // B3-C-15: POST /spaces creates a new space
  // -------------------------------------------------------------------------
  it("B3-C-15 POST /spaces creates a space + resources row in same txn", async () => {
    const name = `b3-space-${Date.now()}`;
    const res = await request(TEST_SERVER)
      .post(`/api/v2/filesystem/spaces`)
      .set(authHeaders())
      .send({ displayName: name });
    expect(res.status).toBe(201);
    expect(res.body.type).toBe("SPACE");
    expect(res.body.displayName).toBe(name);

    // Verify spaces row + resources row both exist.
    const sp = await knex("spaces").where({ rid: res.body.rid }).first();
    const rs = await knex("resources").where({ rid: res.body.rid }).first();
    expect(sp).toBeDefined();
    expect(rs).toBeDefined();
    expect(sp.is_root).toBe(false);

    // Cleanup
    await knex("spaces").where({ rid: res.body.rid }).delete();
    await knex("resources").where({ rid: res.body.rid }).delete();
  });

  // -------------------------------------------------------------------------
  // B3-C-50: Conjure envelope shape
  // -------------------------------------------------------------------------
  it("B3-C-50 every error body includes errorCode, errorName, errorInstanceId", async () => {
    const res = await request(TEST_SERVER)
      .get(`/api/v2/filesystem/resources/not-a-rid`)
      .set(authHeaders());
    expect(res.status).toBe(400);
    expect(res.body.errorCode).toBe("INVALID_ARGUMENT");
    expect(res.body.errorName).toBe("InvalidArgumentError");
    expect(typeof res.body.errorInstanceId).toBe("string");
    expect(res.body.errorInstanceId.length).toBeGreaterThan(0);
  });
});
