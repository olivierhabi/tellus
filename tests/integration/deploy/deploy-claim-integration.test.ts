// ---------------------------------------------------------------------------
// deploy-claim-integration — single-execution fencing for deployments
// (incident 3ec397d5), against real PostgreSQL (lane DB).
//
// The incident: the Temporal pipelineDeployWorkflow activity AND the PG
// pipeline dispatcher both invoked executeDeploymentById for deployment
// 3ec397d5 concurrently. The `status !== 'running'` re-check is a
// non-atomic check-then-act (both read 'running' at start), so both
// executed and double-registered every output.
//
// Covers:
//   • two concurrent executeDeploymentById calls: exactly one executes
//     (claim decides), the loser stands down silently.
//   • a settled deployment is never re-executed.
//   • expired leases are recoverable; a stale worker's heartbeat fails.
//   • the orphan sweeper skips live leases and sweeps expired ones.
// ---------------------------------------------------------------------------

// LANE import must be first: its side effect pins the lane identity into
// process.env before any service module reads it.
import { LANE } from "../../laneEnv";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Knex } from "knex";

import { DeploymentService } from "../../../src/services/deploymentService";
import { sweepOrphanPipelineDeployments } from "../../../src/services/pipelines/pipelineDispatcher";
import {
  RUN,
  createDeployment,
  createProjectTree,
  destroyProjectTree,
  seedUserId,
  type DeployFixtures,
} from "./fixtures";

void LANE;

let knex: Knex;
let fx: DeployFixtures;
let svc: DeploymentService;

beforeAll(async () => {
  const foundryDb = (await import("../../../src/config/foundryDb")).default;
  knex = foundryDb as unknown as Knex;
  const ownerId = await seedUserId(knex);
  fx = await createProjectTree(knex, ownerId, "claim");
  const { TransformService } = await import(
    "../../../src/services/transformService"
  );
  svc = new DeploymentService(knex, new TransformService(knex));
});

afterAll(async () => {
  await destroyProjectTree(knex, fx);
});

describe("deployment execution claim", () => {
  it("two concurrent executors: exactly one builds, the loser stands down", async () => {
    const depId = await createDeployment(knex, fx);
    let buildCalls = 0;
    (svc as unknown as { executeBuild: () => Promise<void> }).executeBuild =
      async () => {
        buildCalls += 1;
      };
    try {
      await Promise.all([
        svc.executeDeploymentById(depId, { workerId: `test-w-A-${RUN}` }),
        svc.executeDeploymentById(depId, { workerId: `test-w-B-${RUN}` }),
      ]);
    } finally {
      delete (svc as unknown as { executeBuild?: unknown }).executeBuild;
    }
    expect(buildCalls).toBe(1);
    const dep = await knex("pipeline_deployments").where({ id: depId }).first();
    expect([`test-w-A-${RUN}`, `test-w-B-${RUN}`]).toContain(dep.claimed_by);
    expect(dep.status).toBe("running");
  });

  it("a settled deployment is never re-executed", async () => {
    const depId = await createDeployment(knex, fx);
    await knex("pipeline_deployments").where({ id: depId }).update({
      status: "succeeded",
      finished_at: knex.fn.now(),
    });
    let buildCalls = 0;
    (svc as unknown as { executeBuild: () => Promise<void> }).executeBuild =
      async () => {
        buildCalls += 1;
      };
    try {
      await svc.executeDeploymentById(depId, { workerId: `test-w-C-${RUN}` });
    } finally {
      delete (svc as unknown as { executeBuild?: unknown }).executeBuild;
    }
    expect(buildCalls).toBe(0);
    const dep = await knex("pipeline_deployments").where({ id: depId }).first();
    expect(dep.claimed_by).toBeNull();
  });

  it("expired leases are recoverable; stale heartbeats fail", async () => {
    const depId = await createDeployment(knex, fx);
    const first = await svc.claimDeployment(depId, `test-w-D-${RUN}`, 1);
    expect(first).not.toBeNull();
    // Within TTL the second worker loses.
    const blocked = await svc.claimDeployment(depId, `test-w-E-${RUN}`, 60);
    expect(blocked).toBeNull();
    // After expiry the second worker recovers through the same atomic path.
    await new Promise((r) => setTimeout(r, 1200));
    const recovered = await svc.claimDeployment(depId, `test-w-E-${RUN}`, 60);
    expect(recovered).not.toBeNull();
    // The stale worker's heartbeat now fails (fenced).
    expect(await svc.renewDeploymentLease(depId, `test-w-D-${RUN}`, 60)).toBe(
      false,
    );
    expect(await svc.renewDeploymentLease(depId, `test-w-E-${RUN}`, 60)).toBe(
      true,
    );
  });

  it("orphan sweeper skips live leases and sweeps expired ones", async () => {
    const liveId = await createDeployment(knex, fx);
    await knex("pipeline_deployments").where({ id: liveId }).update({
      claimed_by: `test-w-F-${RUN}`,
      claimed_at: knex.fn.now(),
      lease_expires_at: knex.raw("now() + interval '10 minutes'"),
      max_run_duration_seconds: 1,
      started_at: knex.raw("now() - interval '1 hour'"),
    });
    const sweptLive = await sweepOrphanPipelineDeployments(knex);
    expect(sweptLive.sweptIds.map(String)).not.toContain(liveId);
    const stillRunning = await knex("pipeline_deployments")
      .where({ id: liveId })
      .first();
    expect(stillRunning.status).toBe("running");

    const deadId = await createDeployment(knex, fx);
    await knex("pipeline_deployments").where({ id: deadId }).update({
      claimed_by: `test-w-G-${RUN}`,
      claimed_at: knex.raw("now() - interval '1 hour'"),
      lease_expires_at: knex.raw("now() - interval '1 hour'"),
      max_run_duration_seconds: 1,
      started_at: knex.raw("now() - interval '1 hour'"),
    });
    const sweptDead = await sweepOrphanPipelineDeployments(knex);
    expect(sweptDead.sweptIds.map(String)).toContain(deadId);
    const swept = await knex("pipeline_deployments")
      .where({ id: deadId })
      .first();
    expect(swept.status).toBe("failed");
  });
});
