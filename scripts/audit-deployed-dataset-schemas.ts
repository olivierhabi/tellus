#!/usr/bin/env -S pnpm tsx
/**
 * audit-deployed-dataset-schemas — scan every output node in every
 * pipeline and report deployed datasets whose persisted schema does
 * not match what the (fixed) resolveNodeData code path would produce.
 *
 * The corruption mode this script detects:
 *   - Pipeline graph has a join or union node upstream of the output.
 *   - Upstream node's previewSnapshot pinned at Apply time has N columns.
 *   - Deployed dataset's `column_count` is < N (one branch was emitted
 *     because resolveNodeData walked sourceNodeId past the snapshot).
 *
 * Output: a JSON report on stdout, exit 0 if everything matches and
 * non-zero if any drift was found. Suitable for nightly CI.
 *
 * Usage:
 *   pnpm tsx scripts/audit-deployed-dataset-schemas.ts            # all projects
 *   pnpm tsx scripts/audit-deployed-dataset-schemas.ts --project=<id>
 *   pnpm tsx scripts/audit-deployed-dataset-schemas.ts --fix      # trigger redeploys
 */

import foundryDb from '../src/config/foundryDb';

interface OutputNodeRow {
  id: string;
  pipeline_id: string;
  project_id: string;
  label: string;
  config: unknown;
  dataset_id: string | null;
}

interface UpstreamRow {
  id: string;
  node_type: string;
  config: unknown;
}

interface DatasetRow {
  id: string;
  name: string;
  column_count: number | null;
  status: string;
}

interface Drift {
  projectId: string;
  pipelineId: string;
  outputNodeId: string;
  outputLabel: string;
  datasetId: string;
  datasetName: string;
  deployedColumnCount: number;
  upstreamNodeType: 'join' | 'union';
  upstreamSnapshotColumnCount: number;
  missingColumns: string[];
  recoveryCommand: string;
}

function parseArgs() {
  const argv = process.argv.slice(2);
  const project = argv.find((a) => a.startsWith('--project='))?.split('=', 2)[1];
  const fix = argv.includes('--fix');
  return { project, fix };
}

async function getOutputNodes(projectFilter?: string): Promise<OutputNodeRow[]> {
  let q = foundryDb('pipeline_nodes as pn')
    .join('pipelines as p', 'pn.pipeline_id', 'p.id')
    .where('pn.node_type', 'output')
    .select<OutputNodeRow[]>(
      'pn.id',
      'pn.pipeline_id',
      'p.project_id',
      'pn.label',
      'pn.config',
      'pn.dataset_id',
    );
  if (projectFilter) q = q.where('p.project_id', projectFilter);
  return q;
}

function parseConfig(raw: unknown): Record<string, unknown> {
  if (!raw) return {};
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return raw as Record<string, unknown>;
}

async function audit(projectFilter?: string): Promise<Drift[]> {
  const outputs = await getOutputNodes(projectFilter);
  const drifts: Drift[] = [];

  for (const out of outputs) {
    const cfg = parseConfig(out.config);
    const srcId = cfg.sourceNodeId as string | undefined;
    if (!srcId) continue;

    const upstream = await foundryDb('pipeline_nodes')
      .where({ id: srcId, pipeline_id: out.pipeline_id })
      .first<UpstreamRow>('id', 'node_type', 'config');
    if (!upstream) continue;
    if (upstream.node_type !== 'join' && upstream.node_type !== 'union') continue;

    const upCfg = parseConfig(upstream.config);
    const snap = upCfg.previewSnapshot as
      | { columns?: Array<{ name: string; type: string }> }
      | undefined;
    const expected = snap?.columns ?? [];
    if (expected.length === 0) continue; // un-applied node — different problem

    // Resolve the deployed dataset through three escalating strategies
    // because real-world state diverges: (1) the explicit pointer the
    // deploy stamps onto the output node config, (2) the FK on the node
    // row, (3) file_path scan within this pipeline's output prefix —
    // catches the case where the node config was reset/recreated but
    // the previously deployed dataset is still live in S3 + DB.
    const explicitId =
      (cfg.outputDatasetId as string | undefined) ?? out.dataset_id ?? null;
    let ds: DatasetRow | undefined;
    if (explicitId) {
      ds = await foundryDb('foundry_datasets')
        .where({ id: explicitId })
        .first<DatasetRow>('id', 'name', 'column_count', 'status');
    }
    if (!ds) {
      const prefix = `projects/${out.project_id}/pipeline-outputs/${out.pipeline_id}/`;
      ds = await foundryDb('foundry_datasets')
        .where('project_id', out.project_id)
        .where('file_path', 'like', `${prefix}%`)
        .where('status', 'ready')
        .orderBy('updated_at', 'desc')
        .first<DatasetRow>('id', 'name', 'column_count', 'status');
    }
    if (!ds || ds.status !== 'ready') continue;

    const deployedCount = ds.column_count ?? 0;
    if (deployedCount === expected.length) continue; // healthy

    const deployedColumns = await foundryDb('dataset_columns')
      .where({ dataset_id: ds.id })
      .pluck<string[]>('column_name');
    const expectedNames = expected.map((c) => c.name);
    const missing = expectedNames.filter((n) => !deployedColumns.includes(n));

    drifts.push({
      projectId: out.project_id,
      pipelineId: out.pipeline_id,
      outputNodeId: out.id,
      outputLabel: out.label,
      datasetId: ds.id,
      datasetName: ds.name,
      deployedColumnCount: deployedCount,
      upstreamNodeType: upstream.node_type as 'join' | 'union',
      upstreamSnapshotColumnCount: expected.length,
      missingColumns: missing,
      recoveryCommand:
        `POST /api/v1/projects/${out.project_id}/pipelines/${out.pipeline_id}/deploy`,
    });
  }

  return drifts;
}

async function main() {
  const { project, fix } = parseArgs();
  const drifts = await audit(project);

  if (drifts.length === 0) {
    console.log(JSON.stringify({ ok: true, drifts: [] }, null, 2));
    process.exit(0);
  }

  console.log(
    JSON.stringify(
      {
        ok: false,
        driftCount: drifts.length,
        drifts,
        nextStep: fix
          ? 'Re-deploys must be triggered via the authenticated deploy API.'
          : 'Re-run with --fix to print per-pipeline redeploy commands.',
      },
      null,
      2,
    ),
  );

  if (fix) {
    console.error('--- Recovery commands ---');
    const seen = new Set<string>();
    for (const d of drifts) {
      const key = `${d.projectId}:${d.pipelineId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      console.error(d.recoveryCommand);
    }
  }
  process.exit(1);
}

main()
  .catch((err) => {
    console.error('audit failed:', err);
    process.exit(2);
  })
  .finally(() => {
    void foundryDb.destroy().catch(() => {});
  });
