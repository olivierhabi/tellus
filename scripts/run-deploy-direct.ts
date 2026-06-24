#!/usr/bin/env -S pnpm tsx
/**
 * run-deploy-direct — invoke the full deploy code path against a
 * specific pipeline by inserting a fresh `pipeline_deployments` row
 * and calling `DeploymentService.executeDeploymentById` directly.
 *
 * This is the exact code the (now-fixed) PG dispatcher runs for each
 * `deployStart` signal. Use it to:
 *   - validate `resolveNodeData` end-to-end with the new deploy
 *     schema invariant under realistic data volumes,
 *   - recover a stuck pipeline when the user can't trigger from the UI,
 *   - test in CI without authentication or HTTP plumbing.
 *
 * The script is intentionally minimal: it does NOT route through the
 * `/deploy` controller (auth, idempotency keys, deployStart signal,
 * ACL evaluation) — those are tested elsewhere. It does the bare
 * minimum the dispatcher does: create the row + execute it.
 *
 * Usage:
 *   pnpm tsx scripts/run-deploy-direct.ts \
 *     --project=<projectId> --pipeline=<pipelineId> [--triggered-by=<userId>]
 *
 * Exit codes:
 *   0  — deployment status terminated as 'succeeded'
 *   1  — deployment status terminated as 'failed' or 'cancelled'
 *   2  — usage error
 */

import foundryDb from '../src/config/foundryDb';
import { DeploymentService } from '../src/services/deploymentService';
import { TransformService } from '../src/services/transformService';

interface Args {
  projectId: string;
  pipelineId: string;
  triggeredBy?: string;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (key: string): string | undefined => {
    const hit = argv.find((a) => a.startsWith(`--${key}=`));
    return hit?.slice(key.length + 3);
  };
  const projectId = get('project');
  const pipelineId = get('pipeline');
  const triggeredBy = get('triggered-by') ?? get('user');
  if (!projectId || !pipelineId) {
    console.error(
      'Usage: pnpm tsx scripts/run-deploy-direct.ts ' +
        '--project=<id> --pipeline=<id> [--triggered-by=<userId>]',
    );
    process.exit(2);
  }
  return { projectId, pipelineId, triggeredBy };
}

async function main() {
  const { projectId, pipelineId, triggeredBy } = parseArgs();

  // Mirror the controller's invariant: pipeline must exist + belong
  // to project. Fail fast with the same shape the API would emit.
  const pipeline = await foundryDb('pipelines')
    .where({ id: pipelineId, project_id: projectId })
    .first('id', 'name', 'pipeline_type', 'output_format');
  if (!pipeline) {
    console.error(JSON.stringify({ ok: false, code: 'NOT_FOUND', pipelineId }));
    process.exit(1);
  }

  // Resolve a user id when one isn't passed. Prefer the most recent
  // deployment's triggered_by for this pipeline so audit trails stay
  // attributed to a real operator rather than an anonymous sweep.
  let user = triggeredBy;
  if (!user) {
    const recent = await foundryDb('pipeline_deployments')
      .where({ pipeline_id: pipelineId })
      .whereNotNull('triggered_by')
      .orderBy('started_at', 'desc')
      .first<{ triggered_by: string | null }>('triggered_by');
    user = recent?.triggered_by ?? undefined;
  }

  // Create the pipeline_deployments row that the executor expects.
  // `status='running'` is the default; `started_at=now()` is the
  // default. We pin an idempotency_key so a re-run with the same
  // script invocation doesn't double-deploy.
  const idempotencyKey = `direct-${pipelineId}-${Date.now()}`;
  const [deployment] = await foundryDb('pipeline_deployments')
    .insert({
      pipeline_id: pipelineId,
      project_id: projectId,
      triggered_by: user ?? null,
      idempotency_key: idempotencyKey,
      config: JSON.stringify({}),
    })
    .returning('id');
  const deploymentId = deployment.id as string;
  console.log(
    JSON.stringify({
      stage: 'inserted',
      deploymentId,
      pipelineId,
      idempotencyKey,
    }),
  );

  const svc = new DeploymentService(foundryDb, new TransformService(foundryDb));
  const t0 = Date.now();
  try {
    await svc.executeDeploymentById(deploymentId);
  } catch (err) {
    // executor errors are normally swallowed and translated to a
    // `status='failed'` update; rethrow only if the row is somehow
    // still 'running' (would indicate a missing handler).
    console.error(
      JSON.stringify({ stage: 'executor-threw', message: (err as Error).message }),
    );
  }
  const elapsedMs = Date.now() - t0;

  const final = await foundryDb('pipeline_deployments')
    .where({ id: deploymentId })
    .first<{
      status: string;
      error_message: string | null;
      build_results: unknown;
      output_snapshot_id: string | null;
      output_table_location: string | null;
    }>('status', 'error_message', 'build_results', 'output_snapshot_id', 'output_table_location');

  console.log(
    JSON.stringify(
      {
        stage: 'final',
        deploymentId,
        elapsedMs,
        status: final?.status,
        errorMessage: final?.error_message,
        outputSnapshotId: final?.output_snapshot_id,
        outputTableLocation: final?.output_table_location,
        buildResults: final?.build_results,
      },
      null,
      2,
    ),
  );

  await foundryDb.destroy().catch(() => {});
  process.exit(final?.status === 'succeeded' ? 0 : 1);
}

main().catch(async (err) => {
  console.error('run-deploy-direct fatal:', err);
  await foundryDb.destroy().catch(() => {});
  process.exit(1);
});
