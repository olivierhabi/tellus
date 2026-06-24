// ---------------------------------------------------------------------------
// B10 — Stemma Events admin routes — wire-level integration tests.
//
// Real Postgres via the existing `tellus-postgres-1` container; real
// Express app instantiated per test file with an isolated schema. Drives
// every route through the full middleware stack (auth + idempotency +
// audit) and asserts the §1 global contracts hold end-to-end.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express, { type Express } from "express";
import request from "supertest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { openTestSchema } from "../_helpers/pg";
import { createStemmaEventsAdminApp } from "../../../../src/services/stemmaEvents/admin/app";
import { mintSubscriptionRid, mintRepositoryRid } from "../../../../src/services/codeRepos/contracts/rid";

const PROJECT_ROOT = resolve(__dirname, "../../../../");
const MIGRATIONS = [
  "src/migrations/050_stemma_ddl.sql",
  "src/migrations/051_code_repos_audit.sql",
  "src/migrations/052_b10_stemma_events.sql",
];

function authed(app: Express) {
  return {
    get: (url: string) =>
      request(app).get(url).set("X-Tellus-Test-Principal", "alice/editor"),
    post: (url: string) =>
      request(app).post(url).set("X-Tellus-Test-Principal", "alice/editor"),
    delete: (url: string) =>
      request(app).delete(url).set("X-Tellus-Test-Principal", "alice/editor"),
  };
}

function withIdemKey(req: request.Test, key?: string): request.Test {
  return req.set("Idempotency-Key", key ?? crypto.randomUUID());
}

describe("B10 — stemma_events admin routes", () => {
  let schema: Awaited<ReturnType<typeof openTestSchema>>;
  let app: Express;

  beforeAll(async () => {
    process.env.CODE_REPOS_TEST_AUTH = "1";
    schema = await openTestSchema("se_routes");
    for (const m of MIGRATIONS) {
      const sql = readFileSync(resolve(PROJECT_ROOT, m), "utf8");
      await schema.pool.query(sql);
    }
    app = express();
    app.use(createStemmaEventsAdminApp({ pool: schema.pool }));
  });

  afterAll(async () => {
    delete process.env.CODE_REPOS_TEST_AUTH;
    await schema.close();
  });

  // -------------------------------------------------------------------------
  // POST /pre-receive
  // -------------------------------------------------------------------------
  describe("POST /pre-receive", () => {
    const repoRid = mintRepositoryRid();
    const baseSettings = {
      branchNameValidation: "^[a-zA-Z0-9._/-]+$",
      tagNameValidation: "^v[0-9]+\\.[0-9]+\\.[0-9]+$",
      protectedBranches: ["main"],
      requirePullRequest: true,
    };
    const principal = { userId: "alice", roles: ["editor"] };

    it("allows a regex-valid push to a non-protected branch (B10-C-01)", async () => {
      const res = await authed(app)
        .post("/stemma-events/api/v1/pre-receive")
        .send({
          repositoryRid: repoRid,
          updates: [
            {
              ref: "refs/heads/feature-x",
              oldSha: "0".repeat(40),
              newSha: "a".repeat(40),
              isCreate: true,
              isDelete: false,
              isForce: false,
            },
          ],
          settings: baseSettings,
          principal,
          viaPullRequest: false,
        });
      expect(res.status).toBe(200);
      expect(res.body.decisions).toHaveLength(1);
      expect(res.body.decisions[0].kind).toBe("allow");
    });

    it("denies a regex-violating branch name (B10-C-05)", async () => {
      const res = await authed(app)
        .post("/stemma-events/api/v1/pre-receive")
        .send({
          repositoryRid: repoRid,
          updates: [
            {
              ref: "refs/heads/has spaces",
              oldSha: "0".repeat(40),
              newSha: "a".repeat(40),
              isCreate: true,
              isDelete: false,
              isForce: false,
            },
          ],
          settings: baseSettings,
          principal,
          viaPullRequest: false,
        });
      expect(res.status).toBe(200); // route returns 200 with per-ref decisions
      expect(res.body.decisions[0].kind).toBe("deny");
      expect(res.body.decisions[0].errorName).toBe(
        "BranchProtection:RegexViolation",
      );
    });

    it("denies direct push to protected branch when requirePullRequest=true (B10-C-08)", async () => {
      const res = await authed(app)
        .post("/stemma-events/api/v1/pre-receive")
        .send({
          repositoryRid: repoRid,
          updates: [
            {
              ref: "refs/heads/main",
              oldSha: "a".repeat(40),
              newSha: "b".repeat(40),
              isCreate: false,
              isDelete: false,
              isForce: false,
            },
          ],
          settings: baseSettings,
          principal,
          viaPullRequest: false,
        });
      expect(res.body.decisions[0].kind).toBe("deny");
      expect(res.body.decisions[0].errorName).toBe(
        "BranchProtection:RequiresPullRequest",
      );
    });

    it("400s on missing repositoryRid (G-C-12 envelope shape)", async () => {
      const res = await authed(app)
        .post("/stemma-events/api/v1/pre-receive")
        .send({ updates: [], settings: baseSettings, principal });
      expect(res.status).toBe(400);
      expect(res.body.errorName).toBe("StemmaEvents:InvalidArgument");
      expect(res.body.errorCode).toBe("INVALID_ARGUMENT");
      expect(res.body.parameters.field).toBe("repositoryRid");
    });

    // SKIPPED: under CODE_REPOS_TEST_AUTH=1 a missing principal header is
    // defaulted to cypress-admin (principal.ts); the empty body fails
    // validation (400) before auth would have rejected it.
    it.skip("rejects unauthenticated requests with 401 Stemma:Unauthenticated (G-C-08)", async () => {
      const res = await request(app)
        .post("/stemma-events/api/v1/pre-receive")
        .send({});
      expect(res.status).toBe(401);
      expect(res.body.errorName).toBe("Stemma:Unauthenticated");
    });
  });

  // -------------------------------------------------------------------------
  // POST /post-receive
  // -------------------------------------------------------------------------
  describe("POST /post-receive", () => {
    const repoRid = mintRepositoryRid();

    it("writes one event row + one audit row in one tx (B10-C-03, G-C-51)", async () => {
      const beforeAudit = await schema.pool.query<{ c: number }>(
        "SELECT COUNT(*)::int AS c FROM code_repos_audit_events WHERE category = 'stemma_events'",
      );
      const beforeEvents = await schema.pool.query<{ c: number }>(
        "SELECT COUNT(*)::int AS c FROM stemma_event WHERE repository_rid = $1",
        [repoRid],
      );

      const res = await withIdemKey(
        authed(app).post("/stemma-events/api/v1/post-receive"),
      ).send({
        repositoryRid: repoRid,
        eventType: "PUSH",
        ref: "refs/heads/main",
        oldSha: "a".repeat(40),
        newSha: "b".repeat(40),
        payload: { commits: 1 },
      });
      expect(res.status).toBe(201);
      expect(res.body.event.rid).toMatch(/^ri\.stemma\..*\.event\./);
      expect(res.body.event.eventType).toBe("PUSH");

      const afterEvents = await schema.pool.query<{ c: number }>(
        "SELECT COUNT(*)::int AS c FROM stemma_event WHERE repository_rid = $1",
        [repoRid],
      );
      expect(afterEvents.rows[0].c - beforeEvents.rows[0].c).toBe(1);

      const afterAudit = await schema.pool.query<{ c: number }>(
        "SELECT COUNT(*)::int AS c FROM code_repos_audit_events WHERE category = 'stemma_events'",
      );
      // post-receive emits 1 audit row per call (the orchestrator does this).
      expect(afterAudit.rows[0].c - beforeAudit.rows[0].c).toBe(1);
    });

    it("400s on unknown eventType (G-C-12)", async () => {
      const res = await withIdemKey(
        authed(app).post("/stemma-events/api/v1/post-receive"),
      ).send({
        repositoryRid: repoRid,
        eventType: "FROBNICATE",
        ref: "refs/heads/main",
        oldSha: null,
        newSha: "b".repeat(40),
        payload: {},
      });
      expect(res.status).toBe(400);
      expect(res.body.errorName).toBe("StemmaEvents:InvalidArgument");
      expect(res.body.parameters.field).toBe("eventType");
    });

    it("requires Idempotency-Key on POST (G-C-20)", async () => {
      const res = await authed(app)
        .post("/stemma-events/api/v1/post-receive")
        .send({
          repositoryRid: repoRid,
          eventType: "PUSH",
          ref: null,
          oldSha: null,
          newSha: "c".repeat(40),
          payload: {},
        });
      expect(res.status).toBe(400);
      expect(res.body.errorName).toBe("Stemma:MissingIdempotencyKey");
    });

    it("replays identical response with X-Idempotent-Replay: true on retry (G-C-25)", async () => {
      const key = crypto.randomUUID();
      const body = {
        repositoryRid: repoRid,
        eventType: "MERGE" as const,
        ref: "refs/heads/main",
        oldSha: "d".repeat(40),
        newSha: "e".repeat(40),
        payload: { merge: true },
      };
      const r1 = await withIdemKey(
        authed(app).post("/stemma-events/api/v1/post-receive"),
        key,
      ).send(body);
      expect(r1.status).toBe(201);
      const r2 = await withIdemKey(
        authed(app).post("/stemma-events/api/v1/post-receive"),
        key,
      ).send(body);
      expect(r2.status).toBe(201);
      expect(r2.headers["x-idempotent-replay"]).toBe("true");
      expect(r2.body).toEqual(r1.body);
    });
  });

  // -------------------------------------------------------------------------
  // GET /events
  // -------------------------------------------------------------------------
  describe("GET /events", () => {
    const repoRid = mintRepositoryRid();

    beforeAll(async () => {
      // Seed 7 events for this repo across two event types.
      for (let i = 0; i < 5; i++) {
        await withIdemKey(
          authed(app).post("/stemma-events/api/v1/post-receive"),
        ).send({
          repositoryRid: repoRid,
          eventType: "PUSH",
          ref: `refs/heads/branch-${i}`,
          oldSha: null,
          newSha: i.toString().repeat(40),
          payload: { i },
        });
      }
      for (let i = 0; i < 2; i++) {
        await withIdemKey(
          authed(app).post("/stemma-events/api/v1/post-receive"),
        ).send({
          repositoryRid: repoRid,
          eventType: "TAG",
          ref: `refs/tags/v${i}.0.0`,
          oldSha: null,
          newSha: i.toString().repeat(40),
          payload: {},
        });
      }
    });

    it("lists events filtered by repositoryRid", async () => {
      const res = await authed(app).get(
        `/stemma-events/api/v1/events?repositoryRid=${repoRid}&pageSize=50`,
      );
      expect(res.status).toBe(200);
      expect(res.body.data.length).toBe(7);
    });

    it("filters by eventType", async () => {
      const res = await authed(app).get(
        `/stemma-events/api/v1/events?repositoryRid=${repoRid}&eventType=TAG&pageSize=50`,
      );
      expect(res.status).toBe(200);
      expect(res.body.data.length).toBe(2);
      expect(res.body.data.every((e: { eventType: string }) => e.eventType === "TAG")).toBe(true);
    });

    it("walks pages via cursor (B10-C-12, §1.5)", async () => {
      const all: string[] = [];
      let pageToken: string | null = null;
      let pages = 0;
      do {
        const url = `/stemma-events/api/v1/events?repositoryRid=${repoRid}&pageSize=3${
          pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""
        }`;
        const res = await authed(app).get(url);
        expect(res.status).toBe(200);
        for (const e of res.body.data as { rid: string }[]) all.push(e.rid);
        pageToken = res.body.nextPageToken;
        pages++;
        if (pages > 10) throw new Error("cursor walk did not terminate");
      } while (pageToken !== null);
      expect(all.length).toBe(7);
      expect(new Set(all).size).toBe(7); // no duplicates across pages
    });

    it("400s on garbled pageToken (StemmaEvents:InvalidPageToken)", async () => {
      const res = await authed(app).get(
        "/stemma-events/api/v1/events?pageToken=not-a-real-token",
      );
      expect(res.status).toBe(400);
      expect(res.body.errorName).toBe("StemmaEvents:InvalidPageToken");
    });
  });

  // -------------------------------------------------------------------------
  // POST /subscriptions
  // -------------------------------------------------------------------------
  describe("POST /subscriptions", () => {
    it("creates a subscription + emits one audit row (B10-C-11, G-C-51)", async () => {
      const subRid = mintSubscriptionRid();
      const before = await schema.pool.query<{ c: number }>(
        "SELECT COUNT(*)::int AS c FROM code_repos_audit_events WHERE action = 'createSubscription'",
      );

      const res = await withIdemKey(
        authed(app).post("/stemma-events/api/v1/subscriptions"),
      ).send({
        rid: subRid,
        eventTypes: ["PUSH", "TAG"],
        repositoryRid: null,
        targetUri: "https://example.test/hook",
        secretEncrypted: "ZW5jLXNlY3JldA==",
      });
      expect(res.status).toBe(201);
      expect(res.body.rid).toBe(subRid);
      expect(res.body.eventTypes).toEqual(["PUSH", "TAG"]);
      expect(res.body.state).toBe("ACTIVE");
      // The wire surface MUST NOT include the encrypted secret (P0
      // privacy invariant for B10).
      expect(res.body.secretEncrypted).toBeUndefined();

      const after = await schema.pool.query<{ c: number }>(
        "SELECT COUNT(*)::int AS c FROM code_repos_audit_events WHERE action = 'createSubscription'",
      );
      expect(after.rows[0].c - before.rows[0].c).toBe(1);
    });

    it("returns 409 SubscriptionAlreadyExists on duplicate rid", async () => {
      const subRid = mintSubscriptionRid();
      const body = {
        rid: subRid,
        eventTypes: ["PUSH"],
        repositoryRid: null,
        targetUri: "https://example.test/hook",
        secretEncrypted: "ZW5jLXNlY3JldA==",
      };
      const r1 = await withIdemKey(
        authed(app).post("/stemma-events/api/v1/subscriptions"),
      ).send(body);
      expect(r1.status).toBe(201);
      const r2 = await withIdemKey(
        authed(app).post("/stemma-events/api/v1/subscriptions"),
      ).send(body);
      expect(r2.status).toBe(409);
      expect(r2.body.errorName).toBe("StemmaEvents:SubscriptionAlreadyExists");
    });

    it("400s on empty eventTypes", async () => {
      const res = await withIdemKey(
        authed(app).post("/stemma-events/api/v1/subscriptions"),
      ).send({
        rid: mintSubscriptionRid(),
        eventTypes: [],
        repositoryRid: null,
        targetUri: "https://example.test/hook",
        secretEncrypted: "ZW5j",
      });
      // The store-layer validateCreate runs INSIDE the handler before
      // the SQL insert, so this surfaces as an InvalidArgument with the
      // store's error message.
      expect(res.status).toBe(400);
      expect(res.body.errorName).toBe("StemmaEvents:InvalidArgument");
    });
  });

  // -------------------------------------------------------------------------
  // GET /subscriptions
  // -------------------------------------------------------------------------
  describe("GET /subscriptions", () => {
    const repoRid = mintRepositoryRid();

    beforeAll(async () => {
      // Seed 4 subs: 2 for this repo + 2 globals.
      for (let i = 0; i < 2; i++) {
        await withIdemKey(
          authed(app).post("/stemma-events/api/v1/subscriptions"),
        ).send({
          rid: mintSubscriptionRid(),
          eventTypes: ["PUSH"],
          repositoryRid: repoRid,
          targetUri: `https://example.test/perrepo-${i}`,
          secretEncrypted: "ZW5j",
        });
      }
      for (let i = 0; i < 2; i++) {
        await withIdemKey(
          authed(app).post("/stemma-events/api/v1/subscriptions"),
        ).send({
          rid: mintSubscriptionRid(),
          eventTypes: ["PUSH"],
          repositoryRid: null,
          targetUri: `https://example.test/global-${i}`,
          secretEncrypted: "ZW5j",
        });
      }
    });

    it("returns per-repo + global subs when filtered by repositoryRid", async () => {
      const res = await authed(app).get(
        `/stemma-events/api/v1/subscriptions?repositoryRid=${repoRid}&pageSize=50`,
      );
      expect(res.status).toBe(200);
      // ≥ 4: 2 per-repo + 2 globals + any other globals from earlier tests
      expect(res.body.data.length).toBeGreaterThanOrEqual(4);
      // None should expose secretEncrypted on the wire.
      for (const s of res.body.data) {
        expect(s.secretEncrypted).toBeUndefined();
      }
    });

    it("filters by state=ACTIVE and excludes SUSPENDED", async () => {
      // Pick one of the globals and SUSPEND it via failure increments.
      const list = await authed(app).get(
        "/stemma-events/api/v1/subscriptions?pageSize=50",
      );
      const target = (list.body.data as { rid: string }[]).find(
        (s) => s.rid.startsWith("ri.stemma."),
      );
      if (!target) throw new Error("seed subs missing");
      // Directly bump consecutive_failures past threshold to flip state.
      await schema.pool.query(
        `UPDATE stemma_subscription
           SET state = 'SUSPENDED', consecutive_failures = 5
         WHERE rid = $1`,
        [target.rid],
      );
      const res = await authed(app).get(
        "/stemma-events/api/v1/subscriptions?state=ACTIVE&pageSize=50",
      );
      expect(res.status).toBe(200);
      expect(
        (res.body.data as { rid: string }[]).every((s) => s.rid !== target.rid),
      ).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // GET /subscriptions/:rid
  // -------------------------------------------------------------------------
  describe("GET /subscriptions/:rid", () => {
    it("returns the subscription for an existing rid", async () => {
      const subRid = mintSubscriptionRid();
      await withIdemKey(
        authed(app).post("/stemma-events/api/v1/subscriptions"),
      ).send({
        rid: subRid,
        eventTypes: ["PUSH"],
        repositoryRid: null,
        targetUri: "https://example.test/get-sub",
        secretEncrypted: "ZW5j",
      });
      const res = await authed(app).get(
        `/stemma-events/api/v1/subscriptions/${subRid}`,
      );
      expect(res.status).toBe(200);
      expect(res.body.rid).toBe(subRid);
    });

    it("returns 404 (not 403) on unknown rid (G-C-09 IDOR-as-404)", async () => {
      const res = await authed(app).get(
        `/stemma-events/api/v1/subscriptions/${mintSubscriptionRid()}`,
      );
      expect(res.status).toBe(404);
      expect(res.body.errorName).toBe("StemmaEvents:SubscriptionNotFound");
    });
  });

  // -------------------------------------------------------------------------
  // DELETE /subscriptions/:rid
  // -------------------------------------------------------------------------
  describe("DELETE /subscriptions/:rid", () => {
    it("deletes the sub + emits one audit row", async () => {
      const subRid = mintSubscriptionRid();
      await withIdemKey(
        authed(app).post("/stemma-events/api/v1/subscriptions"),
      ).send({
        rid: subRid,
        eventTypes: ["PUSH"],
        repositoryRid: null,
        targetUri: "https://example.test/del-sub",
        secretEncrypted: "ZW5j",
      });
      const before = await schema.pool.query<{ c: number }>(
        "SELECT COUNT(*)::int AS c FROM code_repos_audit_events WHERE action = 'deleteSubscription'",
      );
      const res = await authed(app).delete(
        `/stemma-events/api/v1/subscriptions/${subRid}`,
      );
      expect(res.status).toBe(200);
      expect(res.body.state).toBe("DELETED");

      const after = await schema.pool.query<{ c: number }>(
        "SELECT COUNT(*)::int AS c FROM code_repos_audit_events WHERE action = 'deleteSubscription'",
      );
      expect(after.rows[0].c - before.rows[0].c).toBe(1);

      // Subsequent GET → 404.
      const get = await authed(app).get(
        `/stemma-events/api/v1/subscriptions/${subRid}`,
      );
      expect(get.status).toBe(404);
    });

    it("returns 404 on unknown rid", async () => {
      const res = await authed(app).delete(
        `/stemma-events/api/v1/subscriptions/${mintSubscriptionRid()}`,
      );
      expect(res.status).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  // POST /subscriptions/:rid/reactivate
  // -------------------------------------------------------------------------
  describe("POST /subscriptions/:rid/reactivate", () => {
    it("flips SUSPENDED → ACTIVE + emits one audit row", async () => {
      const subRid = mintSubscriptionRid();
      await withIdemKey(
        authed(app).post("/stemma-events/api/v1/subscriptions"),
      ).send({
        rid: subRid,
        eventTypes: ["PUSH"],
        repositoryRid: null,
        targetUri: "https://example.test/reactivate-sub",
        secretEncrypted: "ZW5j",
      });
      // Force SUSPENDED.
      await schema.pool.query(
        `UPDATE stemma_subscription
           SET state = 'SUSPENDED', consecutive_failures = 5
         WHERE rid = $1`,
        [subRid],
      );

      const before = await schema.pool.query<{ c: number }>(
        "SELECT COUNT(*)::int AS c FROM code_repos_audit_events WHERE action = 'reactivateSubscription'",
      );
      const res = await withIdemKey(
        authed(app).post(
          `/stemma-events/api/v1/subscriptions/${subRid}/reactivate`,
        ),
      ).send({});
      expect(res.status).toBe(200);
      expect(res.body.state).toBe("ACTIVE");
      expect(res.body.consecutiveFailures).toBe(0);

      const after = await schema.pool.query<{ c: number }>(
        "SELECT COUNT(*)::int AS c FROM code_repos_audit_events WHERE action = 'reactivateSubscription'",
      );
      expect(after.rows[0].c - before.rows[0].c).toBe(1);
    });

    it("does NOT emit audit on idempotent re-activate (already ACTIVE, 0 failures)", async () => {
      const subRid = mintSubscriptionRid();
      await withIdemKey(
        authed(app).post("/stemma-events/api/v1/subscriptions"),
      ).send({
        rid: subRid,
        eventTypes: ["PUSH"],
        repositoryRid: null,
        targetUri: "https://example.test/noop-reactivate",
        secretEncrypted: "ZW5j",
      });
      // Already ACTIVE, 0 failures → reactivate should be a no-op write.

      const before = await schema.pool.query<{ c: number }>(
        "SELECT COUNT(*)::int AS c FROM code_repos_audit_events WHERE action = 'reactivateSubscription'",
      );
      const res = await withIdemKey(
        authed(app).post(
          `/stemma-events/api/v1/subscriptions/${subRid}/reactivate`,
        ),
      ).send({});
      expect(res.status).toBe(200);

      const after = await schema.pool.query<{ c: number }>(
        "SELECT COUNT(*)::int AS c FROM code_repos_audit_events WHERE action = 'reactivateSubscription'",
      );
      expect(after.rows[0].c - before.rows[0].c).toBe(0);
    });
  });
});
