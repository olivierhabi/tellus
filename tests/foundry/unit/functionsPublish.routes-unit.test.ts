import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";

vi.mock("../../../src/services/codeRepos/middleware/principal", () => ({
  requireCodeReposAuth: () => (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.codeReposPrincipal = {
      userId: "alice",
      source: "test",
      roles: ["editor"],
      scopes: [],
      sourceIp: "127.0.0.1",
      userAgent: "vitest",
    };
    next();
  },
}));

import { functionsPublishRunsRouter } from "../../../src/services/functionsPublish/routes";
import {
  FunctionsPublishError,
  type FunctionsPublishService,
} from "../../../src/services/functionsPublish/service";

const RUN_RID = "ri.jemma.main.run.00000000-0000-4000-8000-000000000001";
const RETRY_RID = "ri.jemma.main.run.00000000-0000-4000-8000-000000000002";
const REPOSITORY_RID = "ri.stemma.main.repository.00000000-0000-4000-8000-000000000003";
const IDEMPOTENCY_KEY = "0123abcd-ef01-4345-8789-abcdef012345";

describe("functions-publish retrigger route", () => {
  it("returns 202 and the new durable run", async () => {
    const retrigger = vi.fn().mockResolvedValue({
      runRid: RETRY_RID,
      sourceRunRid: RUN_RID,
      repositoryRid: REPOSITORY_RID,
      branch: "main",
      commitSha: "a".repeat(40),
      semver: "1.0.0",
      state: "QUEUED",
      replayed: false,
    });
    const pool = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [{
          rid: RETRY_RID,
          repository_rid: REPOSITORY_RID,
          ref: "main",
          commit_sha: "a".repeat(40),
          trigger_kind: "MANUAL",
          triggered_by: "00000000-0000-4000-8000-000000000004",
          job_name: "functions-publish",
          state: "QUEUED",
          failure_reason: null,
          queued_at: new Date("2026-07-20T12:00:00Z"),
          started_at: null,
          finished_at: null,
          pod_name: null,
          resource_version: 1,
          semver: "1.0.0",
          version_rid: null,
          artifact_sha256: null,
          function_rids: {},
        }] })
        .mockResolvedValueOnce({ rows: [] }),
    };
    const app = express();
    app.use(express.json());
    app.use("/api/v1/jemma", functionsPublishRunsRouter({
      pool: pool as unknown as Pool,
      service: { retrigger } as unknown as FunctionsPublishService,
    }));

    const response = await request(app)
      .post(`/api/v1/jemma/runs/${RUN_RID}/retrigger`)
      .set("X-Tellus-Test-Principal", "alice/editor")
      .set("Idempotency-Key", IDEMPOTENCY_KEY);

    expect(response.status).toBe(202);
    expect(response.body.rid).toBe(RETRY_RID);
    expect(response.body.retriggeredFrom).toBe(RUN_RID);
    expect(response.body.state).toBe("QUEUED");
    expect(response.headers.location).toContain(RETRY_RID);
    expect(retrigger).toHaveBeenCalledWith(expect.objectContaining({
      runRid: RUN_RID,
      idempotencyKey: IDEMPOTENCY_KEY,
    }));
  });

  it("rejects a missing idempotency key before invoking the service", async () => {
    const retrigger = vi.fn();
    const app = express();
    app.use("/api/v1/jemma", functionsPublishRunsRouter({
      pool: { query: vi.fn() } as unknown as Pool,
      service: { retrigger } as unknown as FunctionsPublishService,
    }));

    const response = await request(app)
      .post(`/api/v1/jemma/runs/${RUN_RID}/retrigger`)
      .set("X-Tellus-Test-Principal", "alice/editor");

    expect(response.status).toBe(400);
    expect(response.body.errorName).toBe("Jemma:InvalidArgument");
    expect(retrigger).not.toHaveBeenCalled();
  });

  it("returns structured eligibility for an obsolete version", async () => {
    const getRetryEligibility = vi.fn().mockResolvedValue({
      runRid: RUN_RID,
      retryable: false,
      reason: "VERSION_OUTDATED",
      attemptedSemver: "0.0.4",
      latestSemver: "1.0.2",
      suggestedSemver: "1.0.3",
    });
    const app = express();
    app.use("/api/v1/jemma", functionsPublishRunsRouter({
      pool: { query: vi.fn() } as unknown as Pool,
      service: { getRetryEligibility } as unknown as FunctionsPublishService,
    }));

    const response = await request(app)
      .get(`/api/v1/jemma/runs/${RUN_RID}/retry-eligibility`)
      .set("X-Tellus-Test-Principal", "alice/editor");

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      retryable: false,
      reason: "VERSION_OUTDATED",
      suggestedSemver: "1.0.3",
    });
  });

  it("does not enqueue another deterministic version-conflict retry", async () => {
    const retrigger = vi.fn().mockRejectedValue(new FunctionsPublishError(
      "RUN_NOT_RETRYABLE",
      "Version 0.0.4 is lower than the latest release 1.0.2",
      {
        retryable: false,
        reason: "VERSION_OUTDATED",
        attemptedSemver: "0.0.4",
        latestSemver: "1.0.2",
        suggestedSemver: "1.0.3",
      },
    ));
    const app = express();
    app.use("/api/v1/jemma", functionsPublishRunsRouter({
      pool: { query: vi.fn() } as unknown as Pool,
      service: { retrigger } as unknown as FunctionsPublishService,
    }));

    const response = await request(app)
      .post(`/api/v1/jemma/runs/${RUN_RID}/retrigger`)
      .set("X-Tellus-Test-Principal", "alice/editor")
      .set("Idempotency-Key", IDEMPOTENCY_KEY);

    expect(response.status).toBe(409);
    expect(response.body.errorName).toBe("Jemma:RunNotRetryable");
    expect(response.body.parameters.suggestedSemver).toBe("1.0.3");
  });
});
