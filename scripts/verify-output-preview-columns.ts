#!/usr/bin/env -S pnpm tsx
/**
 * verify-output-preview-columns — invokes the exact code path the
 * deploy worker uses (`TransformService.outputPreview`) for a given
 * output node and prints the resulting column list.
 *
 * Before the resolveNodeData fix this returned the leftmost dataset's
 * transformed schema (9 columns for the reported pipeline). After the
 * fix it must return the Union snapshot's schema (11 columns).
 *
 * Usage:
 *   pnpm tsx scripts/verify-output-preview-columns.ts \
 *     --project=<projectId> --pipeline=<pipelineId> --output=<outputNodeId>
 *
 * Exit codes:
 *   0  — preview ran successfully (column list printed)
 *   1  — preview failed (e.g. SNAPSHOT_REQUIRED on an un-applied join/union)
 */

import foundryDb from '../src/config/foundryDb';
import { TransformService } from '../src/services/transformService';

interface Args {
  projectId: string;
  pipelineId: string;
  nodeId: string;
}

function parseArgs(): Args {
  const args = process.argv.slice(2);
  const get = (key: string): string | undefined => {
    const hit = args.find((a) => a.startsWith(`--${key}=`));
    return hit?.slice(key.length + 3);
  };
  const projectId = get('project');
  const pipelineId = get('pipeline');
  const nodeId = get('output');
  if (!projectId || !pipelineId || !nodeId) {
    console.error(
      'Usage: pnpm tsx scripts/verify-output-preview-columns.ts ' +
        '--project=<id> --pipeline=<id> --output=<nodeId>',
    );
    process.exit(2);
  }
  return { projectId, pipelineId, nodeId };
}

async function main() {
  const { projectId, pipelineId, nodeId } = parseArgs();
  const svc = new TransformService(foundryDb);
  try {
    const t0 = Date.now();
    const result = await svc.outputPreview(projectId, pipelineId, nodeId, 1);
    const elapsedMs = Date.now() - t0;
    const cols = result.columns.map((c) => `${c.name}:${c.type}`);
    console.log(
      JSON.stringify(
        {
          ok: true,
          elapsedMs,
          columnCount: result.columns.length,
          totalRows: result.totalRows,
          columns: cols,
        },
        null,
        2,
      ),
    );
    process.exit(0);
  } catch (err: unknown) {
    const e = err as { message?: string; statusCode?: number; code?: string };
    console.error(
      JSON.stringify(
        {
          ok: false,
          status: e.statusCode ?? 500,
          code: e.code ?? 'UNKNOWN',
          message: e.message ?? String(err),
        },
        null,
        2,
      ),
    );
    process.exit(1);
  } finally {
    await foundryDb.destroy().catch(() => {});
  }
}

main();
