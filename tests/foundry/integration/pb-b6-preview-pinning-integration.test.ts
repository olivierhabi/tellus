// ---------------------------------------------------------------------------
// PB-B6 — preview-chain staleness + input_snapshots + divergence_warning
// (integration).
//
// Exercises the deploy service's PB-B6 behaviour against live Postgres:
//   (b) modify chain after preview → deploy rejected with PREVIEW_STALE
//   * force=true overrides the stale check
//   * ?ignorePreviewSnapshot=true records divergence_warning=true on
//     the deployment row
//   (d) input_snapshots JSONB captures per-node previewSnapshot envelopes
//
// Iceberg pinned reads (acceptance a) are exercised by the existing
// PB-B4 sidecar suite; here we prove the deploy path inspects the
// stored previewSnapshot, not the live chain.
// ---------------------------------------------------------------------------

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "crypto";
import foundryDb from "../../../src/config/foundryDb";
import { DeploymentService } from "../../../src/services/deploymentService";
import { TransformService } from "../../../src/services/transformService";
import {
  hashTransformChain,
  fingerprintSchema,
} from "../../../src/services/pipelines/previewSnapshot";

const STAMP = Date.now();
let dbUp = false;
let userId = "";
let projectId = "";
let pipelineId = "";
let outputNodeId = "";
let deploy: DeploymentService;

beforeAll(async () => {
  try {
    await foundryDb.raw("SELECT 1");
    dbUp = true;
  } catch (err) {
    console.warn(`[pb-b6] Postgres unreachable: ${(err as Error).message}`);
    return;
  }

  const [user] = await foundryDb("users")
    .insert({
      email: `pb-b6-${STAMP}@tellus.local`,
      password_hash: "x",
      display_name: `PB-B6 ${STAMP}`,
    })
    .returning("*");
  userId = user.id;

  const [project] = await foundryDb("projects")
    .insert({ name: `pb-b6-${STAMP}`, owner_id: userId })
    .returning("*");
  projectId = project.id;

  const [pipeline] = await foundryDb("pipelines")
    .insert({
      project_id: projectId,
      name: `pipe-${STAMP}`,
      status: "draft",
    })
    .returning("*");
  pipelineId = pipeline.id;

  deploy = new DeploymentService(foundryDb, new TransformService(foundryDb));
});

afterAll(async () => {
  if (!dbUp) return;
  if (pipelineId) {
    await foundryDb("pipeline_signal").where({ pipeline_id: pipelineId }).del();
    await foundryDb("pipeline_deployments").where({ pipeline_id: pipelineId }).del();
    await foundryDb("pipeline_nodes").where({ pipeline_id: pipelineId }).del();
    await foundryDb("pipelines").where({ id: pipelineId }).del();
  }
  if (projectId) await foundryDb("projects").where({ id: projectId }).del();
  if (userId) await foundryDb("users").where({ id: userId }).del();
  await foundryDb.destroy();
});

async function seedOutputWithPreview(transforms: unknown[]): Promise<string> {
  const chainHash = hashTransformChain(transforms);
  const cols = [
    { name: "order_id", type: "integer" },
    { name: "status", type: "string" },
  ];
  const [node] = await foundryDb("pipeline_nodes")
    .insert({
      pipeline_id: pipelineId,
      node_type: "output",
      label: `out_${randomUUID().slice(0, 6)}`,
      position_x: 0,
      position_y: 0,
      config: JSON.stringify({
        transforms,
        previewSnapshot: {
          columns: cols,
          rows: [],
          rowCount: 0,
          transforms,
          chainHash,
          schemaFingerprint: fingerprintSchema(cols),
          savedAt: new Date().toISOString(),
          // Simulate a captured Iceberg-input pin.
          inputSnapshot: {
            datasetId: null,
            format: "iceberg",
            upstreamSnapshotId: "9999999999999999999",
            capturedAt: new Date().toISOString(),
            pinMode: "iceberg-snapshot",
          },
          upstreamSnapshotId: "9999999999999999999",
          format: "iceberg",
        },
      }),
    })
    .returning("*");
  return node.id;
}

describe("PB-B6 preview pinning", () => {
  it("(d) records input_snapshots + preview_chain_hash on the deployment row", async () => {
    if (!dbUp) return;
    const transforms = [{ function: "Drop", columns: ["note"] }];
    outputNodeId = await seedOutputWithPreview(transforms);
    const started = await deploy.startDeployment(
      projectId,
      pipelineId,
      userId,
      { outputNodeIds: [outputNodeId] },
      { idempotencyKey: `d-${randomUUID()}` },
    );
    const row = await foundryDb("pipeline_deployments")
      .where({ id: started.deploymentId })
      .first();
    const snaps = typeof row.input_snapshots === "string"
      ? JSON.parse(row.input_snapshots)
      : row.input_snapshots;
    expect(snaps[outputNodeId]).toBeDefined();
    expect(snaps[outputNodeId].upstreamSnapshotId).toBe("9999999999999999999");
    expect(row.preview_chain_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.divergence_warning).toBe(false);
    expect(row.ignore_preview_snapshot).toBe(false);

    await foundryDb("pipeline_deployments").where({ id: started.deploymentId }).del();
    await foundryDb("pipeline_nodes").where({ id: outputNodeId }).del();
  });

  it("(b) deploy rejected with PREVIEW_STALE when chain hash drifts", async () => {
    if (!dbUp) return;
    outputNodeId = await seedOutputWithPreview([
      { function: "Drop", columns: ["note"] },
    ]);
    // Mutate the live transforms on the node so its hash != previewSnapshot.chainHash.
    const node = await foundryDb("pipeline_nodes").where({ id: outputNodeId }).first();
    const cfg = typeof node.config === "string" ? JSON.parse(node.config) : node.config;
    cfg.transforms = [{ function: "Drop", columns: ["internal_notes"] }]; // different
    await foundryDb("pipeline_nodes")
      .where({ id: outputNodeId })
      .update({ config: JSON.stringify(cfg) });

    try {
      await deploy.startDeployment(
        projectId,
        pipelineId,
        userId,
        { outputNodeIds: [outputNodeId] },
        { idempotencyKey: `s-${randomUUID()}` },
      );
      throw new Error("expected throw");
    } catch (err) {
      expect((err as { code?: string }).code).toBe("PREVIEW_STALE");
      const details = (err as { details?: { staleNodeIds?: string[] } }).details;
      expect(details?.staleNodeIds).toContain(outputNodeId);
    }
    await foundryDb("pipeline_nodes").where({ id: outputNodeId }).del();
  });

  it("force=true overrides the stale check but does NOT flip divergence_warning", async () => {
    if (!dbUp) return;
    outputNodeId = await seedOutputWithPreview([
      { function: "Drop", columns: ["note"] },
    ]);
    // Drift the chain on the node.
    const node = await foundryDb("pipeline_nodes").where({ id: outputNodeId }).first();
    const cfg = typeof node.config === "string" ? JSON.parse(node.config) : node.config;
    cfg.transforms = [{ function: "Rename", renames: [{ from: "status", to: "state" }] }];
    await foundryDb("pipeline_nodes")
      .where({ id: outputNodeId })
      .update({ config: JSON.stringify(cfg) });

    const started = await deploy.startDeployment(
      projectId,
      pipelineId,
      userId,
      { outputNodeIds: [outputNodeId], force: true },
      { idempotencyKey: `f-${randomUUID()}` },
    );
    const row = await foundryDb("pipeline_deployments")
      .where({ id: started.deploymentId })
      .first();
    // force=true skips PREVIEW_STALE but does NOT itself imply divergence
    // against the live upstream — that's ?ignorePreviewSnapshot.
    expect(row.divergence_warning).toBe(false);
    expect(row.ignore_preview_snapshot).toBe(false);

    await foundryDb("pipeline_deployments").where({ id: started.deploymentId }).del();
    await foundryDb("pipeline_nodes").where({ id: outputNodeId }).del();
  });

  it("(e) ?ignorePreviewSnapshot=true records divergence_warning=true", async () => {
    if (!dbUp) return;
    outputNodeId = await seedOutputWithPreview([
      { function: "Drop", columns: ["note"] },
    ]);
    // Drift the chain too so the STALE check would normally fire.
    const node = await foundryDb("pipeline_nodes").where({ id: outputNodeId }).first();
    const cfg = typeof node.config === "string" ? JSON.parse(node.config) : node.config;
    cfg.transforms = [{ function: "Rename", renames: [{ from: "a", to: "b" }] }];
    await foundryDb("pipeline_nodes")
      .where({ id: outputNodeId })
      .update({ config: JSON.stringify(cfg) });

    const started = await deploy.startDeployment(
      projectId,
      pipelineId,
      userId,
      { outputNodeIds: [outputNodeId] },
      {
        idempotencyKey: `ips-${randomUUID()}`,
        ignorePreviewSnapshot: true,
      },
    );
    const row = await foundryDb("pipeline_deployments")
      .where({ id: started.deploymentId })
      .first();
    expect(row.divergence_warning).toBe(true);
    expect(row.ignore_preview_snapshot).toBe(true);

    await foundryDb("pipeline_deployments").where({ id: started.deploymentId }).del();
    await foundryDb("pipeline_nodes").where({ id: outputNodeId }).del();
  });
});
