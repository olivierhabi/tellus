// Shared fixtures for the deploy-fencing integration lane (incident 3ec397d5).
// Every object carries a per-run suffix so concurrent/serial suite runs never
// collide. Cleanup is project-cascade: deleting the project removes folders,
// pipelines, deployments, datasets and nodes (all FKs CASCADE).

import crypto from "node:crypto";
import type { Knex } from "knex";

export const RUN = crypto.randomUUID().replaceAll("-", "").slice(0, 10);

export async function seedUserId(knex: Knex): Promise<string> {
  const row = (await knex("users").select("id").first()) as
    | { id: string }
    | undefined;
  if (!row) throw new Error("lane DB has no users row for fixtures");
  return row.id;
}

export interface DeployFixtures {
  projectId: string;
  folderId: string;
  pipelineId: string;
}

export async function createProjectTree(
  knex: Knex,
  ownerId: string,
  tag: string,
): Promise<DeployFixtures> {
  const projectId = crypto.randomUUID();
  await knex("projects").insert({
    id: projectId,
    name: `fencing-${tag}-${RUN}`,
    owner_id: ownerId,
  });
  const folderId = crypto.randomUUID();
  await knex("folders").insert({
    id: folderId,
    name: `fencing-${tag}-${RUN}`,
    project_id: projectId,
    path: `fencing_${tag}_${RUN}`.replaceAll("-", "_"),
  });
  const pipelineId = crypto.randomUUID();
  await knex("pipelines").insert({
    id: pipelineId,
    project_id: projectId,
    name: `fencing-${tag}-${RUN}`,
  });
  return { projectId, folderId, pipelineId };
}

export async function createDeployment(
  knex: Knex,
  fx: DeployFixtures,
  status = "running",
): Promise<string> {
  const tagless = () => crypto.randomUUID();
  const [row] = (await knex("pipeline_deployments")
    .insert({
      pipeline_id: fx.pipelineId,
      project_id: fx.projectId,
      status,
      config: JSON.stringify({}),
      build_results: JSON.stringify([]),
      // Trigger-enforced (pipeline_deployments_require_idempotency_key).
      idempotency_key: `test-${tagless()}`,
    })
    .returning("id")) as Array<{ id: string }>;
  return row.id;
}

export async function createOutputNode(
  knex: Knex,
  pipelineId: string,
  label: string,
): Promise<string> {
  const [row] = (await knex("pipeline_nodes")
    .insert({ pipeline_id: pipelineId, node_type: "output", label })
    .returning("id")) as Array<{ id: string }>;
  return row.id;
}

export async function destroyProjectTree(
  knex: Knex,
  fx: DeployFixtures,
): Promise<void> {
  await knex("projects").where({ id: fx.projectId }).del();
}
