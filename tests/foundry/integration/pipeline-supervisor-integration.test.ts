// ---------------------------------------------------------------------------
// PB-B1 — supervised pipeline deploys (integration).
//
// Exercises the supervisor contract against a live Postgres:
//   (b) idempotency: same Idempotency-Key → same deploymentId, no 2nd signal
//   (c) cancellation: DELETE mark → worker finalises status='cancelled'
//   (d) orphan sweep: stale running row → status='failed' with supervisor_timeout
//   (f) dispatcher: SKIP LOCKED claim consumes pending signal
//
// We drive the service layer directly (`DeploymentService`, dispatcher) so
// the test is independent of the HTTP stack and Keycloak bootstrap; a
// separate Cypress+bash pair covers the HTTP contract end-to-end.
//
// Skips gracefully if Postgres is not reachable so CI in a minimal sandbox
// doesn't explode.
// ---------------------------------------------------------------------------

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "crypto";
import foundryDb from "../../../src/config/foundryDb";
import { DeploymentService } from "../../../src/services/deploymentService";
import { TransformService } from "../../../src/services/transformService";
import {
  drainPendingPipelineSignals,
  sweepOrphanPipelineDeployments,
} from "../../../src/services/pipelines/pipelineDispatcher";

const STAMP = Date.now();
const PROJECT_NAME = `PB-B1 Fixture ${STAMP}`;
const PIPELINE_NAME = `pb_b1_pipeline_${STAMP}`;

let dbAvailable = false;
let projectId = "";
let pipelineId = "";
let outputNodeId = "";
let userId = "";

let deploymentService: DeploymentService;

beforeAll(async () => {
  try {
    await foundryDb.raw("SELECT 1");
    dbAvailable = true;
  } catch (err) {
    console.warn(
      `[pb-b1] Postgres unreachable (${(err as Error).message}); skipping suite.`,
    );
    return;
  }

  // Fixture: a bare project + pipeline + one 'output' node. We never call
  // executeBuild so we do NOT need a real dataset graph — the PB-B1
  // contract we verify (idempotency, cancellation, sweep, signal claim)
  // operates on pipeline_deployments + pipeline_signal, not on transforms.
  // A dedicated user row satisfies the pipeline_deployments.triggered_by FK.
  const [user] = await foundryDb("users")
    .insert({
      email: `pb-b1-${STAMP}@tellus.local`,
      password_hash: "x",
      display_name: `PB-B1 ${STAMP}`,
    })
    .returning("*");
  userId = user.id;

  const [project] = await foundryDb("projects")
    .insert({ name: PROJECT_NAME, owner_id: userId })
    .returning("*");
  projectId = project.id;

  const [pipeline] = await foundryDb("pipelines")
    .insert({
      project_id: projectId,
      name: PIPELINE_NAME,
      status: "draft",
    })
    .returning("*");
  pipelineId = pipeline.id;

  const [outputNode] = await foundryDb("pipeline_nodes")
    .insert({
      pipeline_id: pipelineId,
      node_type: "output",
      label: "out",
      config: JSON.stringify({}),
      position_x: 0,
      position_y: 0,
    })
    .returning("*");
  outputNodeId = outputNode.id;

  deploymentService = new DeploymentService(
    foundryDb,
    new TransformService(foundryDb),
  );
});

afterAll(async () => {
  if (!dbAvailable) return;
  if (pipelineId) {
    await foundryDb("pipeline_signal").where({ pipeline_id: pipelineId }).del();
    await foundryDb("pipeline_deployments").where({ pipeline_id: pipelineId }).del();
    await foundryDb("pipeline_nodes").where({ pipeline_id: pipelineId }).del();
    await foundryDb("pipelines").where({ id: pipelineId }).del();
  }
  if (projectId) {
    await foundryDb("projects").where({ id: projectId }).del();
  }
  if (userId) {
    await foundryDb("users").where({ id: userId }).del();
  }
  // Destroy the pool so vitest exits cleanly when this is the only suite.
  await foundryDb.destroy();
});

function skipIfNoDb(): boolean {
  if (!dbAvailable) {
    console.warn("[pb-b1] skipping: Postgres unavailable");
    return true;
  }
  return false;
}

describe("PB-B1 supervised deploys", () => {
  it(
    "(b) same Idempotency-Key returns the same deploymentId; no duplicate signal",
    async () => {
      if (skipIfNoDb()) return;
      const key = `pb-b1-idem-${randomUUID()}`;
      const triggeredBy = userId;

      const first = await deploymentService.startDeployment(
        projectId,
        pipelineId,
        triggeredBy,
        { outputNodeIds: [outputNodeId] },
        { idempotencyKey: key },
      );
      expect(first.reused).toBe(false);
      expect(first.idempotencyKey).toBe(key);
      expect(first.idempotencyKeyGenerated).toBe(false);

      const second = await deploymentService.startDeployment(
        projectId,
        pipelineId,
        triggeredBy,
        { outputNodeIds: [outputNodeId] },
        { idempotencyKey: key },
      );
      expect(second.deploymentId).toBe(first.deploymentId);
      expect(second.reused).toBe(true);

      // Only one signal row — second call must not enqueue a duplicate.
      const signals = await foundryDb("pipeline_signal")
        .where({ pipeline_id: pipelineId, signal_fingerprint: key })
        .select("*");
      expect(signals.length).toBe(1);

      // Clean so later tests see a clean slate.
      await foundryDb("pipeline_signal").where({ pipeline_id: pipelineId }).del();
      await foundryDb("pipeline_deployments").where({ id: first.deploymentId }).del();
    },
  );

  it(
    "auto-generates Idempotency-Key when header absent",
    async () => {
      if (skipIfNoDb()) return;
      const res = await deploymentService.startDeployment(
        projectId,
        pipelineId,
        userId,
        { outputNodeIds: [outputNodeId] },
      );
      expect(res.idempotencyKeyGenerated).toBe(true);
      expect(res.idempotencyKey.length).toBeGreaterThan(0);

      await foundryDb("pipeline_signal").where({ pipeline_id: pipelineId }).del();
      await foundryDb("pipeline_deployments").where({ id: res.deploymentId }).del();
    },
  );

  it(
    "(c) cancelDeployment marks cancellation_requested_at and executeDeploymentById finalises status='cancelled'",
    async () => {
      if (skipIfNoDb()) return;
      const key = `pb-b1-cancel-${randomUUID()}`;
      const started = await deploymentService.startDeployment(
        projectId,
        pipelineId,
        userId,
        { outputNodeIds: [outputNodeId] },
        { idempotencyKey: key },
      );
      const deploymentId = started.deploymentId;

      const cancelRes = await deploymentService.cancelDeployment(
        projectId,
        pipelineId,
        deploymentId,
      );
      expect(cancelRes.cancellationRequestedAt.length).toBeGreaterThan(0);

      const afterCancel = await foundryDb("pipeline_deployments")
        .where({ id: deploymentId })
        .first();
      expect(afterCancel.cancellation_requested_at).not.toBeNull();
      expect(afterCancel.status).toBe("running");

      // Worker picks up the deploy: executeDeploymentById must detect the
      // cancellation and finalise without running executeBuild.
      await deploymentService.executeDeploymentById(deploymentId);

      const final = await foundryDb("pipeline_deployments")
        .where({ id: deploymentId })
        .first();
      expect(final.status).toBe("cancelled");
      expect(final.error_message).toBe("cancelled_by_user");
      expect(final.finished_at).not.toBeNull();

      await foundryDb("pipeline_signal").where({ pipeline_id: pipelineId }).del();
      await foundryDb("pipeline_deployments").where({ id: deploymentId }).del();
    },
  );

  it(
    "(d) orphan sweeper marks stale running deploys as failed with supervisor_timeout",
    async () => {
      if (skipIfNoDb()) return;
      const [orphan] = await foundryDb("pipeline_deployments")
        .insert({
          pipeline_id: pipelineId,
          project_id: projectId,
          status: "running",
          triggered_by: userId,
          // 5h ago, default max_run_duration_seconds=14400 (4h) → orphan.
          started_at: foundryDb.raw(`NOW() - INTERVAL '5 hours'`),
          idempotency_key: `pb-b1-orphan-${randomUUID()}`,
        })
        .returning("*");

      const { sweptIds } = await sweepOrphanPipelineDeployments(foundryDb);
      expect(sweptIds).toContain(orphan.id);

      const after = await foundryDb("pipeline_deployments")
        .where({ id: orphan.id })
        .first();
      expect(after.status).toBe("failed");
      expect(after.error_message).toBe("supervisor_timeout");
      expect(after.finished_at).not.toBeNull();

      await foundryDb("pipeline_deployments").where({ id: orphan.id }).del();
    },
  );

  it(
    "(f) dispatcher claims pending 'deployStart' signal and marks it consumed",
    async () => {
      if (skipIfNoDb()) return;
      const key = `pb-b1-disp-${randomUUID()}`;
      const started = await deploymentService.startDeployment(
        projectId,
        pipelineId,
        userId,
        { outputNodeIds: [outputNodeId] },
        { idempotencyKey: key },
      );

      // Pre-cancel so the dispatcher's executeDeploymentById bails out
      // before it tries to upload to S3 — we're only asserting the
      // SKIP LOCKED claim semantics here, not the full build.
      await deploymentService.cancelDeployment(
        projectId,
        pipelineId,
        started.deploymentId,
      );

      // Each dispatcher tick claims at most one signal per pipeline (the
      // pipeline serialises on its output table). Drain until empty.
      let totalProcessed = 0;
      for (let i = 0; i < 5; i++) {
        const n = await drainPendingPipelineSignals({
          pipelineIds: [pipelineId],
          deploymentService,
          knex: foundryDb,
        });
        totalProcessed += n;
        if (n === 0) break;
      }
      expect(totalProcessed).toBeGreaterThan(0);

      const pending = await foundryDb("pipeline_signal")
        .where({ pipeline_id: pipelineId })
        .whereNull("consumed_at")
        .count({ c: "*" })
        .first();
      expect(Number(pending?.c ?? 0)).toBe(0);

      // Deployment should have been finalised by the dispatcher run.
      const final = await foundryDb("pipeline_deployments")
        .where({ id: started.deploymentId })
        .first();
      expect(final.status).toBe("cancelled");

      await foundryDb("pipeline_signal").where({ pipeline_id: pipelineId }).del();
      await foundryDb("pipeline_deployments").where({ id: started.deploymentId }).del();
    },
  );
});
