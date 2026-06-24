// ---------------------------------------------------------------------------
// PB-B10 — schema evolution admission + schemaChanged signal (integration).
//
//   * dryRun returns the classified envelope without enqueuing a deploy.
//   * narrowing without force throws SCHEMA_NARROWING_NOT_SAFE.
//   * force_schema_migration + accept_data_loss allows the unsafe diff.
//   * schemaChanged signal is emitted per-OT with dedup fingerprint.
//   * sidecar update_schema round-trip against live Lakekeeper.
// ---------------------------------------------------------------------------

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "crypto";
import foundryDb from "../../../src/config/foundryDb";
import { DeploymentService } from "../../../src/services/deploymentService";
import { TransformService } from "../../../src/services/transformService";
import {
  fingerprintOutputSchema,
} from "../../../src/services/pipelines/schemaEvolution";

const STAMP = Date.now();
let dbUp = false;
let userId = "";
let projectId = "";
let pipelineId = "";
let outputNodeId = "";
let outputDatasetId = "";
let deploy: DeploymentService;

// ---------------------------------------------------------------------------
// Reachability probes for the PB-B10 sidecar test. The Iceberg sidecar
// round-trips through a live Lakekeeper REST catalog (warehouse) + a
// MinIO/S3 object store (data files). The integration CI job provisions
// postgres/opensearch/keycloak only — Lakekeeper, MinIO, and Temporal are
// absent. S3_ACCESS_KEY_ID/S3_SECRET_ACCESS_KEY may still be set (shared
// secret) so a bare env-presence check is insufficient; we probe the actual
// endpoints. Mirrors the pb-b4 lakekeeperReachable() guard and the tuesday
// isPostgresAvailable()/isOpenSearchAvailable() skip pattern.
// ---------------------------------------------------------------------------

async function lakekeeperReachable(): Promise<boolean> {
  try {
    const res = await fetch(
      `${process.env.LAKEKEEPER_URL ?? "http://localhost:8181"}/management/v1/info`,
      { signal: AbortSignal.timeout(2_000) },
    );
    return res.ok;
  } catch {
    return false;
  }
}

function s3ProbeUrl(): string {
  const endpoint =
    process.env.ICEBERG_S3_ENDPOINT ??
    process.env.S3_ENDPOINT ??
    "http://localhost:9000";
  // The dev DNS override (PB_B4_LOCAL_DNS_OVERRIDE) rewrites the docker-
  // internal `minio` host to `localhost` inside the python sidecar; mirror
  // that here so the probe targets the same address the sidecar hits.
  return endpoint.replace(/:\/\/minio\b/, "://localhost");
}

async function minioReachable(): Promise<boolean> {
  try {
    const res = await fetch(`${s3ProbeUrl()}/minio/health/live`, {
      signal: AbortSignal.timeout(2_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// Lakekeeper's /management/v1/info answers 2xx even when no warehouse is
// provisioned; the REST catalog's config fetch is what actually fails
// (NoSuchWarehouseException). Probe it so a server-up-but-warehouse-missing
// environment skips instead of crashing.
async function warehouseReachable(): Promise<boolean> {
  try {
    const base = process.env.LAKEKEEPER_URL ?? "http://localhost:8181";
    const warehouse =
      process.env.LAKEKEEPER_PIPELINE_WAREHOUSE ??
      process.env.LAKEKEEPER_WAREHOUSE ??
      "tellus-pipeline";
    const url = `${base}/catalog/v1/config?warehouse=${encodeURIComponent(warehouse)}`;
    const r = await fetch(url, { signal: AbortSignal.timeout(2_000) });
    return r.ok; // 200 = warehouse provisioned; 404 = NoSuchWarehouse
  } catch {
    return false;
  }
}

beforeAll(async () => {
  try {
    await foundryDb.raw("SELECT 1");
    dbUp = true;
  } catch (err) {
    console.warn(`[pb-b10] Postgres unreachable: ${(err as Error).message}`);
    return;
  }

  const [user] = await foundryDb("users")
    .insert({
      email: `pb-b10-${STAMP}@tellus.local`,
      password_hash: "x",
      display_name: `PB-B10 ${STAMP}`,
    })
    .returning("*");
  userId = user.id;
  const [project] = await foundryDb("projects")
    .insert({ name: `pb-b10-${STAMP}`, owner_id: userId })
    .returning("*");
  projectId = project.id;
  const [pipeline] = await foundryDb("pipelines")
    .insert({
      project_id: projectId,
      name: `pipe-${STAMP}`,
      status: "draft",
      created_by: userId,
    })
    .returning("*");
  pipelineId = pipeline.id;
  // Seed creator as owner so RBAC admission passes.
  await foundryDb("pipeline_acl").insert({
    pipeline_id: pipelineId,
    principal_id: userId,
    principal_type: "user",
    role: "owner",
    granted_by: userId,
  });
  // A pre-existing output dataset + prior schema so the diff has
  // something meaningful to compare against.
  const [ds] = await foundryDb("foundry_datasets")
    .insert({
      name: `pb-b10-out-${STAMP}`,
      project_id: projectId,
      file_path: `fake/pb-b10-${STAMP}.parquet`,
      format: "parquet",
    })
    .returning("*");
  outputDatasetId = ds.id;
  await foundryDb("dataset_columns").insert([
    {
      dataset_id: outputDatasetId,
      column_name: "id",
      column_type: "long",
      ordinal_position: 1,
      nullable: true,
    },
    {
      dataset_id: outputDatasetId,
      column_name: "amount",
      column_type: "int64",
      ordinal_position: 2,
      nullable: true,
    },
  ]);
  // Persist the prior fingerprint to trigger a `changed` diff.
  const priorFp = fingerprintOutputSchema([
    { name: "id", type: "long" },
    { name: "amount", type: "int64" },
  ]);
  await foundryDb("foundry_datasets")
    .where({ id: outputDatasetId })
    .update({ last_output_schema_fingerprint: priorFp });

  const [node] = await foundryDb("pipeline_nodes")
    .insert({
      pipeline_id: pipelineId,
      node_type: "output",
      label: "out",
      position_x: 0,
      position_y: 0,
      dataset_id: outputDatasetId,
      config: JSON.stringify({
        outputDatasetId,
        columns: [
          { name: "id", type: "long" },
          { name: "amount", type: "int32" }, // narrowing from the prior long
        ],
      }),
    })
    .returning("*");
  outputNodeId = node.id;

  deploy = new DeploymentService(foundryDb, new TransformService(foundryDb));
});

afterAll(async () => {
  if (!dbUp) return;
  if (pipelineId) {
    await foundryDb("funnel_signal")
      .whereIn("signal_fingerprint", await foundryDb("funnel_signal")
        .where("signal_fingerprint", "like", "schema:%")
        .pluck("signal_fingerprint"))
      .del();
    await foundryDb("pipeline_signal").where({ pipeline_id: pipelineId }).del();
    await foundryDb("pipeline_deployments").where({ pipeline_id: pipelineId }).del();
    await foundryDb("pipeline_acl").where({ pipeline_id: pipelineId }).del();
    await foundryDb("pipeline_nodes").where({ pipeline_id: pipelineId }).del();
    await foundryDb("pipelines").where({ id: pipelineId }).del();
  }
  if (outputDatasetId) {
    await foundryDb("dataset_columns").where({ dataset_id: outputDatasetId }).del();
    await foundryDb("foundry_datasets").where({ id: outputDatasetId }).del();
  }
  if (projectId) await foundryDb("projects").where({ id: projectId }).del();
  if (userId) await foundryDb("users").where({ id: userId }).del();
  await foundryDb.destroy();
});

describe("PB-B10 schema evolution admission", () => {
  it("dryRun returns classified envelope and does NOT persist a deployment", async () => {
    if (!dbUp) return;
    const before = await foundryDb("pipeline_deployments")
      .where({ pipeline_id: pipelineId })
      .count({ c: "*" })
      .first();
    const res = await deploy.startDeployment(
      projectId,
      pipelineId,
      userId,
      { outputNodeIds: [outputNodeId] },
      { idempotencyKey: randomUUID(), dryRun: true },
    );
    expect("dryRun" in res && res.dryRun).toBe(true);
    if ("dryRun" in res) {
      expect(res.changed).toBe(true);
      expect(res.willBeSafe).toBe(false);
      expect(res.blockingIssues.some((b) => b.op === "narrowing")).toBe(true);
    }
    const after = await foundryDb("pipeline_deployments")
      .where({ pipeline_id: pipelineId })
      .count({ c: "*" })
      .first();
    expect(Number(after?.c ?? 0)).toBe(Number(before?.c ?? 0));
  });

  it("narrowing without force throws SCHEMA_NARROWING_NOT_SAFE", async () => {
    if (!dbUp) return;
    try {
      await deploy.startDeployment(
        projectId,
        pipelineId,
        userId,
        { outputNodeIds: [outputNodeId] },
        { idempotencyKey: randomUUID() },
      );
      throw new Error("expected throw");
    } catch (err) {
      expect((err as { code?: string }).code).toBe("SCHEMA_NARROWING_NOT_SAFE");
      const details = (err as { details?: { blockingIssues: unknown[] } }).details;
      expect(details?.blockingIssues?.length).toBeGreaterThan(0);
    }
  });

  it("force_schema_migration + accept_data_loss admits the unsafe deploy", async () => {
    if (!dbUp) return;
    const res = await deploy.startDeployment(
      projectId,
      pipelineId,
      userId,
      { outputNodeIds: [outputNodeId] },
      {
        idempotencyKey: randomUUID(),
        forceSchemaMigration: true,
        acceptDataLoss: true,
      },
    );
    expect("deploymentId" in res).toBe(true);
    if ("deploymentId" in res) {
      const row = await foundryDb("pipeline_deployments")
        .where({ id: res.deploymentId })
        .first();
      expect(row).toBeDefined();
      await foundryDb("pipeline_signal").where({ pipeline_id: pipelineId }).del();
      await foundryDb("pipeline_deployments").where({ id: res.deploymentId }).del();
    }
  });
});

describe("PB-B10 sidecar update_schema (live Lakekeeper)", () => {
  it("applies add_column through the sidecar and bumps schema_id", async () => {
    const {
      icebergCreateOrGet,
      icebergUpdateSchema,
      icebergSidecarAvailable,
    } = await import("../../../src/services/pipelines/icebergSidecar");
    const {
      pipelineNamespace,
      slugForNamespace,
    } = await import("../../../src/services/pipelines/icebergNamespace");
    // Reachability guard: the sidecar writes Iceberg snapshots through a live
    // Lakekeeper REST catalog + MinIO/S3 object store. CI's integration job
    // provisions neither, and S3_ACCESS_KEY_ID/S3_SECRET_ACCESS_KEY may be set
    // (shared secret) so env-presence alone is not enough. Skip gracefully
    // unless pyiceberg, Lakekeeper, the S3/MinIO backend are all reachable
    // with credentials configured.
    const sidecarUp = await icebergSidecarAvailable();
    const lkUp = await lakekeeperReachable();
    const minioUp = await minioReachable();
    const warehouseUp = await warehouseReachable();
    const s3CredsConfigured =
      !!process.env.S3_ACCESS_KEY_ID && !!process.env.S3_SECRET_ACCESS_KEY;
    if (!sidecarUp || !lkUp || !minioUp || !warehouseUp || !s3CredsConfigured) {
      console.warn(
        `[pb-b10] skipping sidecar test — sidecar=${sidecarUp} lakekeeper=${lkUp} minio=${minioUp} warehouse=${warehouseUp} s3creds=${s3CredsConfigured}`,
      );
      return;
    }
    process.env.PB_B4_LOCAL_DNS_OVERRIDE = "1";
    const namespace = pipelineNamespace(
      slugForNamespace(`evolve_${STAMP}`),
      slugForNamespace(`pipe_${STAMP}`),
    );
    await icebergCreateOrGet({
      namespace,
      table: "output",
      columns: [
        { name: "id", type: "integer" },
        { name: "amount", type: "numeric" },
      ],
    });
    const res = await icebergUpdateSchema({
      namespace,
      table: "output",
      operations: [{ op: "add_column", name: "status", type: "string" }],
    });
    expect(res.applied).toBe(1);
    expect(typeof res.schemaId).toBe("number");
  }, 120_000);
});
