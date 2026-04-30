import { Knex } from 'knex';
import fs from 'fs';
import { randomUUID } from 'crypto';
import { uploadObject } from './storageService';
import { TransformService } from './transformService';
import { AppError } from '../utils/foundryAppError';
import {
  writeRowsToParquet,
  discardStagedParquet,
  pipelineTypeToParquetLogicalType,
} from './pipelines/parquetWriter';
import {
  icebergCreateOrGet,
  icebergAppend,
  icebergRollback,
  icebergSidecarAvailable,
} from './pipelines/icebergSidecar';
import {
  pipelineNamespace,
  PIPELINE_LEAF_TABLE,
  slugForNamespace,
} from './pipelines/icebergNamespace';
import {
  validatePartitionSpec,
} from './pipelines/icebergPartitionSpec';
import {
  compileStreamingJob,
  type DatasetNode as FlinkDatasetNode,
} from './pipelines/flinkSqlCompiler';
import {
  getFlinkAdapter,
  type StreamingStats,
} from './pipelines/flinkAdapter';
import {
  getGuard as getThroughputGuard,
  DEFAULT_MAX_PARALLELISM,
  DEFAULT_HARD_CEILING_BYTES_PER_SEC,
} from './throughputGuard';
import { isRbacEnabled as isRbacEnabledForDeploy } from './pipelines/pipelineAcl';
import {
  recordDeployDuration,
  incActiveDeploys,
  addInputRowsProcessed,
} from './pipelines/metrics';

// ─── CSV Serialization (RFC 4180) ───────────────────────────────────────────

function escapeCsvField(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  const str = String(value);
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function rowsToCsvBuffer(
  columns: Array<{ name: string; type: string }>,
  rows: Array<Record<string, unknown>>,
): Buffer {
  const header = columns.map((c) => escapeCsvField(c.name)).join(',');
  const lines = [header];
  for (const row of rows) {
    const line = columns.map((c) => escapeCsvField(row[c.name])).join(',');
    lines.push(line);
  }
  return Buffer.from(lines.join('\n') + '\n', 'utf-8');
}

// ─── Types ──────────────────────────────────────────────────────────────────

interface BuildResult {
  nodeId: string;
  nodeLabel: string;
  datasetId: string;
  datasetName: string;
  filePath: string;
  rowCount: number;
  columnCount: number;
  status: 'succeeded' | 'failed';
  error?: string;
  durationMs: number;
}

export interface DeployPipelineInput {
  outputNodeIds?: string[];
  /**
   * PB-B6 — bypass the preview-chain-hash stale check. Typed client
   * only passes this when the user explicitly confirmed they want to
   * deploy an edited chain.
   */
  force?: boolean;
}

export interface StartDeploymentOptions {
  /**
   * Client-supplied dedup token (HTTP `Idempotency-Key` header). When
   * two calls arrive with the same key within the dedup window, the
   * second one is a no-op and the existing deployment is returned.
   */
  idempotencyKey?: string;
  /**
   * Set to true when the server auto-generated the idempotency key.
   * The controller surfaces this via `Idempotency-Key-Generated` so
   * clients can carry the key on retries.
   */
  idempotencyKeyGenerated?: boolean;
  /**
   * If true (default), PB-B1 supervisor mode: enqueue a pipeline_signal
   * and return immediately — the dispatcher executes the build. When
   * false the caller runs the build inline (legacy path, used by tests
   * that drive the pipeline synchronously).
   */
  useSupervisor?: boolean;
  /**
   * PB-B6 — `?ignorePreviewSnapshot=true` from the query string. When
   * set, the deploy runs against the latest upstream instead of the
   * captured previewSnapshot; the deployment row records
   * divergence_warning=true + the actual snapshot used.
   */
  ignorePreviewSnapshot?: boolean;
  /**
   * PB-B10 — `?force_schema_migration=true&accept_data_loss=true`. Admin
   * override that lets a narrowing / cross-family schema change land.
   * Without BOTH flags the classifier rejects with
   * SCHEMA_NARROWING_NOT_SAFE.
   */
  forceSchemaMigration?: boolean;
  acceptDataLoss?: boolean;
  /**
   * PB-B10 — `?dryRun=true`. When set, startDeployment returns a
   * `DryRunResult` instead of enqueuing a real deploy; NO DB mutations
   * happen.
   */
  dryRun?: boolean;
}

/** PB-B10 — returned from startDeployment in dry-run mode. */
export interface DryRunResult {
  dryRun: true;
  changed: boolean;
  priorFingerprint: string | null;
  newFingerprint: string;
  willBeSafe: boolean;
  schemaDiff: Array<Record<string, unknown>>;
  blockingIssues: Array<Record<string, unknown>>;
}

export interface StartDeploymentResult {
  deploymentId: string;
  status: string;
  startedAt: string;
  outputCount: number;
  idempotencyKey: string;
  idempotencyKeyGenerated: boolean;
  /** True when ON CONFLICT matched an existing row; the deploy was a no-op. */
  reused: boolean;
}

// ─── DeploymentService ──────────────────────────────────────────────────────
//
// Async deployment pattern:
//
//   1. POST /deploy → creates deployment record (status: 'running'), returns
//      immediately with { deploymentId, status: 'running' }.
//   2. Builds run in the background (fire-and-forget).
//   3. Frontend polls GET /deployments/:id every 2s to get current status.
//   4. When builds finish, deployment record is updated to 'succeeded'/'failed'.
//
// This prevents HTTP timeouts on large datasets and gives the UI real-time
// progress visibility.

export class DeploymentService {
  constructor(
    private knex: Knex,
    private transformService: TransformService,
  ) {}

  /**
   * Start a deployment — PB-B1 supervised path.
   *
   * Semantics:
   *   1. Validate pipeline + output nodes.
   *   2. INSERT pipeline_deployments ... ON CONFLICT (idempotency_key) DO NOTHING.
   *      If the insert collided, return the pre-existing row so the same
   *      Idempotency-Key always maps to the same deploymentId.
   *   3. Enqueue a 'deployStart' row in pipeline_signal. The dispatcher
   *      (src/services/pipelines/pipelineDispatcher.ts) claims it with
   *      FOR UPDATE SKIP LOCKED on its 2s tick and calls executeDeploymentById.
   *   4. Return the unchanged envelope — the HTTP response shape that the
   *      existing frontend expects (deploymentId/status/startedAt/outputCount).
   *
   * `opts.useSupervisor=false` runs executeBuild inline for tests that need
   * synchronous completion. Production always takes the supervised path.
   */
  async startDeployment(
    projectId: string,
    pipelineId: string,
    triggeredBy: string,
    input: DeployPipelineInput,
    opts: StartDeploymentOptions = {},
  ): Promise<StartDeploymentResult | DryRunResult> {
    // Validate pipeline
    const pipeline = await this.knex('pipelines')
      .where({ id: pipelineId, project_id: projectId })
      .first();
    if (!pipeline) throw new AppError('Pipeline not found', 404, 'NOT_FOUND');

    // Find output nodes
    const allNodes = await this.knex('pipeline_nodes')
      .where({ pipeline_id: pipelineId })
      .select('*');

    let outputNodes = allNodes.filter((n: { node_type: string }) => n.node_type === 'output');
    if (input.outputNodeIds && input.outputNodeIds.length > 0) {
      const selectedSet = new Set(input.outputNodeIds);
      outputNodes = outputNodes.filter((n: { id: string }) => selectedSet.has(n.id));
    }

    if (outputNodes.length === 0) {
      throw new AppError(
        'No output nodes to build. Add at least one output node to the pipeline.',
        400,
        'NO_OUTPUTS',
      );
    }

    // PB-B10 — schema evolution admission (runs before RBAC/marking so
    // the dry-run preview works for a user who has the role but hasn't
    // committed the migration yet). Computes fingerprint + diff of the
    // (first) output node's declared column list against the last
    // deployed schema. Dry-run short-circuits BEFORE any persistence.
    const schemaEvolution = await this.computeSchemaEvolutionForOutputs(
      outputNodes,
    );
    if (opts.dryRun === true) {
      return {
        dryRun: true,
        changed: schemaEvolution.changed,
        priorFingerprint: schemaEvolution.priorFingerprint,
        newFingerprint: schemaEvolution.newFingerprint,
        willBeSafe: schemaEvolution.willBeSafe,
        schemaDiff: schemaEvolution.operations as unknown as Array<Record<string, unknown>>,
        blockingIssues: schemaEvolution.blockingIssues as unknown as Array<Record<string, unknown>>,
      };
    }
    if (
      schemaEvolution.changed &&
      !schemaEvolution.willBeSafe &&
      !(opts.forceSchemaMigration === true && opts.acceptDataLoss === true)
    ) {
      // Pick the most actionable blocking issue as the error code head.
      const narrowing = schemaEvolution.blockingIssues.find(
        (b) => b.op === 'narrowing',
      );
      const code = narrowing
        ? 'SCHEMA_NARROWING_NOT_SAFE'
        : 'SCHEMA_EVOLUTION_BLOCKED';
      const err = new AppError(
        `Deploy rejected: ${schemaEvolution.blockingIssues.length} schema change(s) require force_schema_migration=true&accept_data_loss=true.`,
        409,
        code,
      );
      (err as unknown as { details?: unknown }).details = {
        blockingIssues: schemaEvolution.blockingIssues,
        priorFingerprint: schemaEvolution.priorFingerprint,
        newFingerprint: schemaEvolution.newFingerprint,
      };
      throw err;
    }

    // PB-B7 — Marking propagation + access check.
    //
    // Before the deploy is enqueued we:
    //   1. Aggregate `markings` across every input dataset into
    //      `pipelines.input_markings` (union, not intersection — see
    //      services/markingUnion.ts). Shares the exact helper the
    //      Funnel's mergeStage uses for per-row marking union.
    //   2. Require the triggering user to possess ALL of those
    //      markings (required ⊆ user). Failure → 403
    //      MISSING_MARKING:<name> with a `missing` audit record.
    //   3. Stamp the union onto pipelines.input_markings so the row
    //      carries an audit trail that an ops engineer can diff
    //      against the Funnel's marking state.
    //
    // When RBAC_ENABLED=false the admission is skipped entirely so
    // pre-PB-B7 tenants keep running through the deprecation window.
    const { applyMarkingPolicyAtDeploy } = await import('./pipelines/markingPolicy');
    const markingResult = await applyMarkingPolicyAtDeploy(
      this.knex,
      pipelineId,
      allNodes,
      triggeredBy,
    );
    // Persist the computed union back onto the pipeline for audit.
    await this.knex('pipelines')
      .where({ id: pipelineId })
      .update({ input_markings: markingResult.unionMarkings });

    // PB-B7 follow-cbac — condition-based access rules. Every enabled
    // rule on the pipeline must evaluate truthy against the
    // (user, pipeline, project) context; on failure throw
    // CBAC_RULE_VIOLATION so the audit trail logs WHICH rule rejected
    // the deploy. Skipped when RBAC_ENABLED=false (same posture as
    // the marking policy).
    if (isRbacEnabledForDeploy()) {
      const { assertCbacAdmission } = await import('./pipelines/cbacEvaluator');
      const userRow = await this.knex('users')
        .where({ id: triggeredBy })
        .first('email');
      const projectRow = await this.knex('projects')
        .where({ id: projectId })
        .first('id', 'name', 'owner_id');
      await assertCbacAdmission(
        pipelineId,
        {
          user: {
            id: triggeredBy,
            email: userRow?.email ?? null,
            groups: [],
          },
          pipeline: { id: pipelineId, name: pipeline.name ?? null, projectId },
          project: {
            id: projectId,
            name: projectRow?.name ?? null,
            ownerId: projectRow?.owner_id ?? null,
          },
          nowSec: Math.floor(Date.now() / 1000),
        },
        this.knex,
      );
    }

    // PB-B6 — preview-snapshot staleness + input-snapshot aggregation.
    //
    // Every pipeline_node with a saved previewSnapshot carries a
    // chainHash captured at preview time. If the user has edited the
    // transforms since, the hash drifts and we refuse the deploy
    // (PREVIEW_STALE) unless input.force=true. `?ignorePreviewSnapshot`
    // is a SEPARATE escape hatch that additionally skips the input
    // pinning and records divergence_warning on the deploy row.
    const pinning = await this.collectPreviewPinning(
      pipelineId,
      allNodes,
      {
        force: input.force === true,
        ignorePreviewSnapshot: opts.ignorePreviewSnapshot === true,
      },
    );

    // Idempotency key — either client-supplied (Idempotency-Key header) or
    // server-generated for one deprecation cycle. The controller echoes
    // generated keys back so clients can carry them on retries.
    const idempotencyKeyGenerated = !opts.idempotencyKey;
    const idempotencyKey = opts.idempotencyKey ?? randomUUID();

    const startedAt = new Date();
    const configJson = JSON.stringify({
      selectedOutputs: outputNodes.map((n: { id: string; label: string }) => ({
        id: n.id,
        label: n.label,
      })),
    });

    // Atomic idempotent insert. ON CONFLICT DO NOTHING returns an empty
    // result set when the key already exists; we then SELECT the prior
    // row so the caller sees a stable deploymentId.
    const insertResult = await this.knex.raw(
      `INSERT INTO pipeline_deployments
         (pipeline_id, project_id, status, triggered_by, started_at,
          config, build_results, idempotency_key,
          input_snapshots, divergence_warning, ignore_preview_snapshot,
          preview_chain_hash)
       VALUES (?, ?, 'running', ?, ?, ?::jsonb, '[]'::jsonb, ?,
               ?::jsonb, ?, ?, ?)
       ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL
         DO NOTHING
       RETURNING id, started_at`,
      [
        pipelineId,
        projectId,
        triggeredBy,
        startedAt.toISOString(),
        configJson,
        idempotencyKey,
        JSON.stringify(pinning.inputSnapshots),
        pinning.divergenceWarning,
        opts.ignorePreviewSnapshot === true,
        pinning.chainHashDigest,
      ],
    );

    const inserted = (insertResult?.rows ?? insertResult ?? [])[0];
    let deploymentId: string;
    let deploymentStartedAt: string;
    let reused = false;

    if (inserted?.id) {
      deploymentId = inserted.id;
      deploymentStartedAt = (inserted.started_at instanceof Date
        ? inserted.started_at.toISOString()
        : String(inserted.started_at));
    } else {
      // Collision — fetch the pre-existing row.
      const existing = await this.knex('pipeline_deployments')
        .where({ idempotency_key: idempotencyKey })
        .first();
      if (!existing) {
        // Race between our INSERT and another writer's DELETE. Extremely
        // unlikely; retry once so we don't 500.
        throw new AppError(
          'Idempotency-Key conflict with no resolvable row; retry',
          409,
          'IDEMPOTENCY_RACE',
        );
      }
      deploymentId = existing.id;
      deploymentStartedAt = (existing.started_at instanceof Date
        ? existing.started_at.toISOString()
        : String(existing.started_at));
      reused = true;
    }

    const useSupervisor = opts.useSupervisor !== false;

    if (reused) {
      // Fast path: dedup hit — do not enqueue a second signal.
      return {
        deploymentId,
        status: 'running',
        startedAt: deploymentStartedAt,
        outputCount: outputNodes.length,
        idempotencyKey,
        idempotencyKeyGenerated,
        reused: true,
      };
    }

    if (useSupervisor) {
      // Enqueue for the dispatcher. The fingerprint equals the idempotency
      // key so re-delivery from a transient failure still dedupes.
      await this.knex.raw(
        `INSERT INTO pipeline_signal
           (pipeline_id, project_id, deployment_id, signal_type, payload,
            signal_fingerprint)
         VALUES (?, ?, ?, 'deployStart', ?::jsonb, ?)
         ON CONFLICT (pipeline_id, signal_fingerprint)
           WHERE signal_fingerprint IS NOT NULL
           DO NOTHING`,
        [
          pipelineId,
          projectId,
          deploymentId,
          JSON.stringify({ triggeredBy, idempotencyKey }),
          idempotencyKey,
        ],
      );

      // PB-B1 spec-literal — when Temporal is connected, also start the
      // PipelineDeployWorkflow so execution runs through Temporal's
      // retry + heartbeat machinery. The PG dispatcher's `temporalActive`
      // branch recognises that Temporal is authoritative and marks the
      // signal consumed without double-executing.
      try {
        const { isTemporalConnected } = await import("./funnel/temporal/worker");
        if (isTemporalConnected()) {
          const { Connection, Client } = await import("@temporalio/client");
          const address = process.env.TEMPORAL_ADDRESS ?? "localhost:7233";
          const namespace = process.env.TEMPORAL_NAMESPACE ?? "tellus-funnel";
          const taskQueue = process.env.TEMPORAL_TASK_QUEUE ?? "tellus-funnel-queue";
          const conn = await Connection.connect({ address });
          const client = new Client({ connection: conn, namespace });
          // PB-B9 — propagate the inbound HTTP request's trace_id into
          // the Temporal workflow so spans stitch across HTTP → workflow
          // → activity → DuckDB/Iceberg. We push trace_id onto:
          //   * workflowId (pipeline-deploy-<id>-t<trace>) — visible in
          //     Temporal UI and greppable across logs;
          //   * args.traceId — available inside the workflow via
          //     `workflowInfo().args` for activity options and logs.
          const { currentTrace } = await import("./traceContext");
          const trace = currentTrace();
          const traceId = trace?.traceId ?? null;
          const spanId = trace?.spanId ?? null;
          await client.workflow.start("pipelineDeployWorkflow", {
            taskQueue,
            workflowId: `pipeline-deploy-${deploymentId}`,
            args: [{
              projectId,
              pipelineId,
              deploymentId,
              idempotencyKey,
              traceId,
              spanId,
            }],
          }).catch((err: Error) => {
            // Workflow-already-started is the expected replay case.
            if (/WorkflowExecutionAlreadyStarted/i.test(err.message)) return;
            throw err;
          });
        }
      } catch (err) {
        console.warn(
          `[deploy] Temporal workflow start failed (falling back to PG dispatcher): ${(err as Error).message}`,
        );
      }
    } else {
      // Legacy inline path (tests only). Fire-and-forget mirrors the
      // prior behaviour so deploymentService tests that don't run the
      // dispatcher still exercise the build.
      this.executeDeploymentById(deploymentId).catch((err) => {
        console.error(
          `[DeploymentService] inline build failed for deployment ${deploymentId}:`,
          err,
        );
      });
    }

    return {
      deploymentId,
      status: 'running',
      startedAt: deploymentStartedAt,
      outputCount: outputNodes.length,
      idempotencyKey,
      idempotencyKeyGenerated,
      reused: false,
    };
  }

  /**
   * Dispatcher entry point: run the build for a persisted deployment row.
   * Re-loads pipeline + output nodes so the worker is independent of any
   * in-memory state the enqueuing API pod held. Cancellation is
   * cooperative: between outputs the worker polls
   * `pipeline_deployments.cancellation_requested_at` and exits with
   * status='cancelled' if set.
   */
  async executeDeploymentById(deploymentId: string): Promise<void> {
    const deployment = await this.knex('pipeline_deployments')
      .where({ id: deploymentId })
      .first();
    if (!deployment) {
      console.warn(`[DeploymentService] deployment ${deploymentId} not found`);
      return;
    }
    if (deployment.status !== 'running') {
      // Already finalised — defend against double-dispatch.
      return;
    }
    if (deployment.cancellation_requested_at) {
      await this.finaliseCancelled(deploymentId, []);
      return;
    }

    const pipeline = await this.knex('pipelines')
      .where({ id: deployment.pipeline_id })
      .first();
    if (!pipeline) {
      await this.knex('pipeline_deployments')
        .where({ id: deploymentId })
        .update({
          status: 'failed',
          finished_at: new Date().toISOString(),
          error_message: 'pipeline_deleted_before_build',
        });
      return;
    }

    const cfg = typeof deployment.config === 'string'
      ? JSON.parse(deployment.config)
      : (deployment.config ?? {});
    const selectedIds = Array.isArray(cfg.selectedOutputs)
      ? (cfg.selectedOutputs as Array<{ id: string }>).map((s) => s.id)
      : [];

    const allNodes = await this.knex('pipeline_nodes')
      .where({ pipeline_id: deployment.pipeline_id })
      .select('*');

    let outputNodes = allNodes.filter((n: { node_type: string }) => n.node_type === 'output');
    if (selectedIds.length > 0) {
      const selectedSet = new Set(selectedIds);
      outputNodes = outputNodes.filter((n: { id: string }) => selectedSet.has(n.id));
    }

    // PB-B5 — streaming pipelines: no one-shot transform. Compile the
    // node graph to Flink SQL, submit the job, record flink_job_id,
    // and leave the deploy row in 'running_streaming'. The DELETE
    // route issues stop --savepoint; restart issues a fresh submit
    // from the savepoint. Batch pipelines fall through to executeBuild
    // unchanged (acceptance (e)).
    if (pipeline.pipeline_type === 'streaming') {
      await this.executeStreamingBuild(
        deployment.project_id,
        deployment.pipeline_id,
        deploymentId,
        outputNodes,
        pipeline,
      );
      return;
    }

    await this.executeBuild(
      deployment.project_id,
      deployment.pipeline_id,
      deploymentId,
      deployment.triggered_by,
      outputNodes,
      pipeline,
    );
  }

  private async executeStreamingBuild(
    projectId: string,
    pipelineId: string,
    deploymentId: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    outputNodes: any[],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    pipeline: any,
  ): Promise<void> {
    // 1. Validate streaming caps via ThroughputGuard (acceptance f).
    const guard = getThroughputGuard(`pipeline:${pipelineId}`);
    const requestedParallelism = Number(pipeline.streaming_parallelism ?? 4);
    const pv = guard.validateParallelism(requestedParallelism);
    if (!pv.ok) {
      await this.finaliseFailed(
        deploymentId,
        `parallelism=${requestedParallelism} exceeds DEFAULT_MAX_PARALLELISM=${DEFAULT_MAX_PARALLELISM}`,
      );
      return;
    }
    if (pipeline.streaming_throughput_mbps) {
      const rate = Number(pipeline.streaming_throughput_mbps) * 1024 * 1024;
      const rv = guard.validateRateRequest(rate);
      if (!rv.ok) {
        await this.finaliseFailed(
          deploymentId,
          `throughput ${pipeline.streaming_throughput_mbps} MB/s exceeds hard ceiling ${DEFAULT_HARD_CEILING_BYTES_PER_SEC / 1024 / 1024} MB/s`,
        );
        return;
      }
    }

    // 2. Gather source dataset nodes + their columns. The output node
    // carries the final schema; other dataset nodes are the sources.
    const datasetNodes = await this.knex('pipeline_nodes as pn')
      .leftJoin('foundry_datasets as fd', 'pn.dataset_id', 'fd.id')
      .where({ 'pn.pipeline_id': pipelineId, 'pn.node_type': 'dataset' })
      .select(
        'pn.id as id',
        'pn.label as label',
        'fd.file_path as file_path',
        'fd.format as format',
      );

    const sourceCols = await Promise.all(
      datasetNodes.map(async (n: { id: string; file_path?: string | null }) => {
        if (!n.file_path) return [];
        const cols = await this.knex('dataset_columns as dc')
          .join('pipeline_nodes as pn', 'pn.dataset_id', 'dc.dataset_id')
          .where({ 'pn.id': n.id })
          .select('dc.column_name as name', 'dc.column_type as type')
          .orderBy('dc.ordinal_position', 'asc');
        return cols.map((c: { name: string; type: string }) => ({ name: c.name, type: c.type }));
      }),
    );

    const sources: FlinkDatasetNode[] = datasetNodes.map(
      (
        n: { id: string; label: string; file_path?: string | null; format?: string | null },
        i: number,
      ) => ({
        id: n.id,
        label: n.label ?? `src_${i}`,
        // 'stream' when the dataset is explicitly a kafka stream; all
        // other formats are 'batch' sources (Iceberg/Parquet/CSV).
        kind: (n.format === 'stream' ? 'stream' : 'batch') as 'stream' | 'batch',
        source: n.file_path ?? '',
        columns: sourceCols[i] ?? [],
      }),
    );

    if (sources.length === 0) {
      await this.finaliseFailed(
        deploymentId,
        'Streaming pipeline has no dataset source nodes.',
      );
      return;
    }

    // 3. Pull transforms + output schema from the (single) output node.
    //    v1 supports one output per streaming pipeline; multi-output
    //    Flink jobs are follow-up PB-B5.follow-1.
    const out = outputNodes[0];
    const outCfg = typeof out.config === 'string'
      ? JSON.parse(out.config)
      : (out.config ?? {});
    const transforms = Array.isArray(outCfg.transforms) ? outCfg.transforms : [];
    const outputSchema = Array.isArray(outCfg.columns)
      ? outCfg.columns.map((c: { name: string; type: string }) => ({ name: c.name, type: c.type }))
      : (sources[0]?.columns ?? []);

    // 4. Compile the Flink SQL job. Rejections (STREAMING_TRANSFORM_NOT_SUPPORTED)
    //    bubble up as AppError and land as deploy failures with the
    //    typed code on the deployment row.
    const projectSlug = `proj_${projectId.replace(/-/g, '').slice(0, 12)}`;
    const pipelineSlug = `${(pipeline.name ?? 'pipe').toString()}_${pipelineId.replace(/-/g, '').slice(0, 8)}`;
    const jobName = `tellus_pb_b5_${projectSlug}_${pipelineSlug}`;

    let plan;
    try {
      plan = compileStreamingJob({
        jobName,
        inputs: sources,
        transforms,
        outputSchema,
        outputIceberg: {
          warehouse:
            process.env.LAKEKEEPER_PIPELINE_WAREHOUSE ?? 'tellus-pipeline',
          namespace: `_pipeline.${projectSlug}.${pipelineSlug}`,
          table: 'output',
          catalogUri: process.env.LAKEKEEPER_URL ?? 'http://localhost:8181',
        },
        parallelism: requestedParallelism,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const code = (err as { code?: string }).code ?? 'STREAMING_COMPILE_FAILED';
      await this.finaliseFailed(deploymentId, `${code}: ${msg}`);
      return;
    }

    // 5. Submit via the adapter (noop by default in dev, HTTP when
    //    FLINK_URL is set). Record flink_job_id + streaming_runtime
    //    on the deployment so DELETE / restart can find the job.
    const adapter = getFlinkAdapter();
    const submit = await adapter.submitSql({
      jobName,
      plan,
      parallelism: requestedParallelism,
      savepointDir:
        process.env.FLINK_SAVEPOINT_DIR ?? 's3://iceberg-warehouse/_pipeline_savepoints',
    });

    await this.knex('pipeline_deployments')
      .where({ id: deploymentId })
      .update({
        flink_job_id: submit.flinkJobId,
        streaming_runtime: pipeline.streaming_runtime ?? 'flink',
        status: 'running_streaming',
        build_results: JSON.stringify([
          {
            nodeId: out.id,
            nodeLabel: out.label,
            datasetId: '',
            datasetName: out.label,
            filePath: `flink://${submit.flinkJobId}`,
            rowCount: 0,
            columnCount: outputSchema.length,
            status: 'succeeded',
            durationMs: 0,
          },
        ]),
      });
  }

  private async finaliseFailed(
    deploymentId: string,
    message: string,
  ): Promise<void> {
    await this.knex('pipeline_deployments')
      .where({ id: deploymentId })
      .update({
        status: 'failed',
        finished_at: new Date().toISOString(),
        error_message: message,
      });
  }

  /**
   * PB-B5 — stop a streaming deploy with a savepoint. Returns the
   * savepoint path so the frontend can show it on the deploy row.
   * Used by the DELETE handler when pipeline_type='streaming'.
   */
  async stopStreamingDeploy(
    projectId: string,
    pipelineId: string,
    deploymentId: string,
    opts: { drainOnly?: boolean } = {},
  ): Promise<{ deploymentId: string; status: string; savepointPath: string | null }> {
    const deployment = await this.knex('pipeline_deployments')
      .where({ id: deploymentId, pipeline_id: pipelineId, project_id: projectId })
      .first();
    if (!deployment) throw new AppError('Deployment not found', 404, 'NOT_FOUND');
    if (!deployment.flink_job_id) {
      throw new AppError(
        'Deployment has no Flink job id — nothing to stop.',
        400,
        'NO_FLINK_JOB',
      );
    }
    await this.knex('pipeline_deployments')
      .where({ id: deploymentId })
      .update({ status: 'draining' });
    const adapter = getFlinkAdapter();
    const res = await adapter.stopWithSavepoint({
      flinkJobId: deployment.flink_job_id,
      savepointDir:
        process.env.FLINK_SAVEPOINT_DIR ?? 's3://iceberg-warehouse/_pipeline_savepoints',
      drainOnly: opts.drainOnly,
    });
    const finalStatus = opts.drainOnly ? 'cancelled' : 'cancelled';
    await this.knex('pipeline_deployments')
      .where({ id: deploymentId })
      .update({
        status: finalStatus,
        savepoint_path: res.savepointPath,
        finished_at: new Date().toISOString(),
      });
    return {
      deploymentId,
      status: finalStatus,
      savepointPath: res.savepointPath,
    };
  }

  /**
   * PB-B5 — restart a stopped streaming deploy from its savepoint.
   * Produces a NEW deployment row so the caller sees the full audit
   * trail (original deploy + restart).
   */
  async restartStreamingDeploy(
    projectId: string,
    pipelineId: string,
    deploymentId: string,
  ): Promise<{ newDeploymentId: string; flinkJobId: string }> {
    const prior = await this.knex('pipeline_deployments')
      .where({ id: deploymentId, pipeline_id: pipelineId, project_id: projectId })
      .first();
    if (!prior) throw new AppError('Deployment not found', 404, 'NOT_FOUND');
    if (!prior.savepoint_path) {
      throw new AppError(
        'Deployment has no savepoint_path — cannot restart.',
        400,
        'NO_SAVEPOINT',
      );
    }
    const pipeline = await this.knex('pipelines')
      .where({ id: pipelineId, project_id: projectId })
      .first();
    if (!pipeline) throw new AppError('Pipeline not found', 404, 'NOT_FOUND');
    // Re-compile the plan from the current pipeline state (users may
    // have tweaked transforms between stop and restart; savepoint
    // recovery handles state, NOT topology).
    const adapter = getFlinkAdapter();
    const datasetNodes = await this.knex('pipeline_nodes as pn')
      .where({ 'pn.pipeline_id': pipelineId, 'pn.node_type': 'dataset' })
      .select('pn.id', 'pn.label', 'pn.dataset_id');
    const outNodes = await this.knex('pipeline_nodes')
      .where({ pipeline_id: pipelineId, node_type: 'output' });
    const out = outNodes[0];
    if (!out) throw new AppError('No output node on pipeline.', 400, 'NO_OUTPUTS');
    const outCfg = typeof out.config === 'string' ? JSON.parse(out.config) : (out.config ?? {});
    const transforms = Array.isArray(outCfg.transforms) ? outCfg.transforms : [];
    const outputSchema = Array.isArray(outCfg.columns)
      ? outCfg.columns.map((c: { name: string; type: string }) => ({ name: c.name, type: c.type }))
      : [];

    const sources: FlinkDatasetNode[] = datasetNodes.map(
      (n: { id: string; label: string }, i: number) => ({
        id: n.id,
        label: n.label ?? `src_${i}`,
        kind: 'stream' as const,
        source: '',
        columns: [],
      }),
    );

    const projectSlug = `proj_${projectId.replace(/-/g, '').slice(0, 12)}`;
    const pipelineSlug = `${(pipeline.name ?? 'pipe').toString()}_${pipelineId.replace(/-/g, '').slice(0, 8)}`;
    const jobName = `tellus_pb_b5_${projectSlug}_${pipelineSlug}`;
    const plan = compileStreamingJob({
      jobName,
      inputs: sources,
      transforms,
      outputSchema,
      outputIceberg: {
        warehouse: process.env.LAKEKEEPER_PIPELINE_WAREHOUSE ?? 'tellus-pipeline',
        namespace: `_pipeline.${projectSlug}.${pipelineSlug}`,
        table: 'output',
        catalogUri: process.env.LAKEKEEPER_URL ?? 'http://localhost:8181',
      },
      parallelism: Number(pipeline.streaming_parallelism ?? 4),
    });
    const res = await adapter.restartFromSavepoint({
      jobName,
      plan,
      parallelism: Number(pipeline.streaming_parallelism ?? 4),
      savepointPath: prior.savepoint_path,
    });

    const [inserted] = await this.knex('pipeline_deployments')
      .insert({
        pipeline_id: pipelineId,
        project_id: projectId,
        triggered_by: prior.triggered_by,
        status: 'running_streaming',
        flink_job_id: res.flinkJobId,
        streaming_runtime: pipeline.streaming_runtime ?? 'flink',
        idempotency_key: `restart-${deploymentId}-${Date.now()}`,
        config: JSON.stringify({ restartedFrom: deploymentId }),
      })
      .returning('*');
    return { newDeploymentId: inserted.id, flinkJobId: res.flinkJobId };
  }

  /**
   * PB-B5 — streaming-stats endpoint. Pulls watermarks, lag, checkpoint
   * health from the Flink adapter. Always returns a honest shape even
   * when the adapter can't reach Flink (the noop adapter reports
   * state='NOT_FOUND' rather than synthesised telemetry).
   */
  async getStreamingStats(
    projectId: string,
    pipelineId: string,
    deploymentId: string,
  ): Promise<StreamingStats & { adapter: string }> {
    const deployment = await this.knex('pipeline_deployments')
      .where({ id: deploymentId, pipeline_id: pipelineId, project_id: projectId })
      .first();
    if (!deployment) throw new AppError('Deployment not found', 404, 'NOT_FOUND');
    if (!deployment.flink_job_id) {
      throw new AppError(
        'Deployment has no Flink job id.',
        400,
        'NO_FLINK_JOB',
      );
    }
    const adapter = getFlinkAdapter();
    const stats = await adapter.getStats(deployment.flink_job_id);
    return { ...stats, adapter: adapter.mode };
  }

  /**
   * Mark a running deployment as cancellation-requested. The dispatcher
   * worker running `executeBuild` polls the column between outputs and
   * exits cleanly with status='cancelled'. A cancellation signal is also
   * enqueued so multi-pod / Temporal deployments get notified; in PG-only
   * mode the signal is a no-op (the column is the authority).
   *
   * NOTE (PB-B1 risk): until PB-B4 Iceberg outputs land, already-committed
   * CSV output files are NOT rolled back on cancellation — only the
   * remaining unstarted outputs are skipped.
   */
  async cancelDeployment(
    projectId: string,
    pipelineId: string,
    deploymentId: string,
  ): Promise<{ deploymentId: string; status: string; cancellationRequestedAt: string }> {
    const existing = await this.knex('pipeline_deployments')
      .where({ id: deploymentId, pipeline_id: pipelineId, project_id: projectId })
      .first();
    if (!existing) throw new AppError('Deployment not found', 404, 'NOT_FOUND');

    if (existing.status !== 'running' && existing.status !== 'running_streaming') {
      return {
        deploymentId,
        status: existing.status,
        cancellationRequestedAt: existing.cancellation_requested_at
          ? new Date(existing.cancellation_requested_at).toISOString()
          : '',
      };
    }

    // PB-B5 — streaming deploys are cancelled by stopping the Flink job
    // with a savepoint. We hand off to stopStreamingDeploy which both
    // calls the adapter and updates the row; the envelope we return
    // still matches the batch contract so the existing frontend works.
    if (existing.status === 'running_streaming' || existing.flink_job_id) {
      try {
        const stopped = await this.stopStreamingDeploy(
          projectId, pipelineId, deploymentId,
        );
        return {
          deploymentId,
          status: stopped.status,
          cancellationRequestedAt: new Date().toISOString(),
        };
      } catch (err) {
        console.warn(
          `[deploy] streaming stopWithSavepoint failed, falling back to cooperative cancel: ${(err as Error).message}`,
        );
      }
    }

    const now = new Date();
    await this.knex('pipeline_deployments')
      .where({ id: deploymentId })
      .update({ cancellation_requested_at: now.toISOString() });

    // Best-effort signal for Temporal / multi-pod setups. Fingerprint is
    // scoped to the deployment ID so a double-DELETE dedupes.
    try {
      await this.knex.raw(
        `INSERT INTO pipeline_signal
           (pipeline_id, project_id, deployment_id, signal_type, payload,
            signal_fingerprint)
         VALUES (?, ?, ?, 'cancelDeployment', ?::jsonb, ?)
         ON CONFLICT (pipeline_id, signal_fingerprint)
           WHERE signal_fingerprint IS NOT NULL
           DO NOTHING`,
        [
          pipelineId,
          projectId,
          deploymentId,
          JSON.stringify({ deploymentId }),
          `cancel:${deploymentId}`,
        ],
      );
    } catch (err) {
      console.warn(
        `[DeploymentService] failed to enqueue cancel signal: ${(err as Error).message}`,
      );
    }

    return {
      deploymentId,
      status: 'running',
      cancellationRequestedAt: now.toISOString(),
    };
  }

  /**
   * PB-B4 — list Iceberg snapshots for the pipeline's output table. Each
   * row has (snapshot_id, parent_id, timestamp_ms, operation, summary).
   * When output_format != 'iceberg' this is an empty list (we do not
   * pretend there's an Iceberg history).
   */
  async listOutputSnapshots(
    projectId: string,
    pipelineId: string,
  ): Promise<{ snapshots: Array<Record<string, unknown>> }> {
    const pipeline = await this.knex('pipelines')
      .where({ id: pipelineId, project_id: projectId })
      .first();
    if (!pipeline) throw new AppError('Pipeline not found', 404, 'NOT_FOUND');
    if (pipeline.output_format !== 'iceberg') {
      return { snapshots: [] };
    }
    const warehouse =
      process.env.LAKEKEEPER_PIPELINE_WAREHOUSE ?? 'tellus-pipeline';
    const projectSlug = slugForNamespace(
      `proj_${projectId.replace(/-/g, '').slice(0, 12)}`,
    );
    const pipelineSlug = slugForNamespace(
      `${(pipeline.name ?? 'pipe').toString()}_${pipelineId.replace(/-/g, '').slice(0, 8)}`,
    );
    const namespace = pipelineNamespace(projectSlug, pipelineSlug);
    const { icebergSnapshots } = await import('./pipelines/icebergSidecar');
    const { snapshots } = await icebergSnapshots({
      warehouse,
      namespace,
      table: PIPELINE_LEAF_TABLE,
    });
    return { snapshots: snapshots as unknown as Array<Record<string, unknown>> };
  }

  /**
   * PB-B4 — time-travel scan. Returns rows at a specific snapshot_id
   * (or latest if omitted). This wraps the sidecar's scan_as_of action
   * which routes through PyIceberg's scan API; the spec also allows
   * DuckDB's iceberg_scan as a read path but on this binding that is
   * read-only and slower, so the sidecar owns this for now.
   */
  async readOutputAsOf(
    projectId: string,
    pipelineId: string,
    opts: { snapshotId?: number | string; limit?: number } = {},
  ): Promise<{ columns: string[]; rows: Array<Record<string, unknown>>; rowCount: number }> {
    const pipeline = await this.knex('pipelines')
      .where({ id: pipelineId, project_id: projectId })
      .first();
    if (!pipeline) throw new AppError('Pipeline not found', 404, 'NOT_FOUND');
    if (pipeline.output_format !== 'iceberg') {
      throw new AppError(
        "Time-travel scans are only supported on Iceberg-backed pipelines.",
        400,
        'OUTPUT_NOT_ICEBERG',
      );
    }
    const warehouse =
      process.env.LAKEKEEPER_PIPELINE_WAREHOUSE ?? 'tellus-pipeline';
    const projectSlug = slugForNamespace(
      `proj_${projectId.replace(/-/g, '').slice(0, 12)}`,
    );
    const pipelineSlug = slugForNamespace(
      `${(pipeline.name ?? 'pipe').toString()}_${pipelineId.replace(/-/g, '').slice(0, 8)}`,
    );
    const namespace = pipelineNamespace(projectSlug, pipelineSlug);
    const { icebergScanAsOf } = await import('./pipelines/icebergSidecar');
    const res = await icebergScanAsOf({
      warehouse,
      namespace,
      table: PIPELINE_LEAF_TABLE,
      snapshotId: opts.snapshotId,
      limit: opts.limit,
    });
    return {
      columns: res.columns,
      rows: res.rows,
      rowCount: res.row_count,
    };
  }

  /**
   * PB-B3 — atomically switch a pipeline's output_format to 'parquet' and
   * trigger a re-deploy against the existing output dataset. Rejects any
   * pipeline whose schema has NULL-typed columns (SCHEMA_NOT_TYPED_FOR_PARQUET)
   * because Parquet requires concrete types.
   *
   * The re-deploy runs through the standard supervised path from PB-B1 so
   * the caller gets the usual deployment envelope + cancellation story.
   */
  async migrateOutputFormat(
    projectId: string,
    pipelineId: string,
    triggeredBy: string,
    target: 'parquet',
  ): Promise<{
    pipelineId: string;
    outputFormat: string;
    deploymentId: string;
    status: string;
    startedAt: string;
    outputCount: number;
    idempotencyKey: string;
    untypedColumns?: Array<{ datasetId: string; column: string }>;
  }> {
    const pipeline = await this.knex('pipelines')
      .where({ id: pipelineId, project_id: projectId })
      .first();
    if (!pipeline) throw new AppError('Pipeline not found', 404, 'NOT_FOUND');

    if (pipeline.output_format === target) {
      // No-op — still kick a re-deploy so the caller gets a fresh dataset
      // snapshot (matches spec's "re-deploy the pipeline" semantic).
    }

    // Validate every output node's schema for Parquet-safety. Parquet
    // disallows NULL-typed columns (untyped) — the legacy schema inference
    // path writes 'text' for CSV but schema_info may still carry null
    // entries from older inferred datasets. Surface the exact offending
    // columns so the user can fix them before retrying.
    if (target === 'parquet') {
      const untyped = await this.findUntypedColumns(pipelineId);
      if (untyped.length > 0) {
        const err = new AppError(
          `Cannot migrate pipeline to Parquet: ${untyped.length} column(s) have null/untyped schema. ` +
            'Add explicit Cast transforms upstream of the output node for each column.',
          400,
          'SCHEMA_NOT_TYPED_FOR_PARQUET',
        );
        // Attach the offending list in a way the controller can surface.
        (err as unknown as { details?: unknown }).details = { untypedColumns: untyped };
        throw err;
      }
    }

    await this.knex('pipelines')
      .where({ id: pipelineId, project_id: projectId })
      .update({ output_format: target });

    const started = await this.startDeployment(
      projectId,
      pipelineId,
      triggeredBy,
      {},
      { idempotencyKey: `migrate-${pipelineId}-${target}-${Date.now()}` },
    );
    // migrateOutputFormat always calls startDeployment without dryRun,
    // so the union's StartDeploymentResult branch is guaranteed.
    if ('dryRun' in started && (started as { dryRun?: boolean }).dryRun === true) {
      throw new AppError(
        'migrateOutputFormat should never return dryRun envelope',
        500,
        'INTERNAL_ERROR',
      );
    }
    const s = started as Exclude<typeof started, { dryRun: true }>;
    return {
      pipelineId,
      outputFormat: target,
      deploymentId: s.deploymentId,
      status: s.status,
      startedAt: s.startedAt,
      outputCount: s.outputCount,
      idempotencyKey: s.idempotencyKey,
    };
  }

  /**
   * Walk every output-node dataset attached to the pipeline and return
   * the (datasetId, column) pairs whose `column_type` is null/empty.
   */
  private async findUntypedColumns(
    pipelineId: string,
  ): Promise<Array<{ datasetId: string; column: string }>> {
    const rows = await this.knex('dataset_columns as dc')
      .join('pipeline_nodes as pn', 'pn.dataset_id', 'dc.dataset_id')
      .where({ 'pn.pipeline_id': pipelineId, 'pn.node_type': 'output' })
      .whereRaw(
        "dc.column_type IS NULL OR dc.column_type = '' OR LOWER(dc.column_type) = 'null'",
      )
      .select('dc.dataset_id as dataset_id', 'dc.column_name as column_name');
    return rows.map((r: { dataset_id: string; column_name: string }) => ({
      datasetId: r.dataset_id,
      column: r.column_name,
    }));
  }

  /**
   * PB-B6 — walk every pipeline_node with a saved previewSnapshot and:
   *   * detect chain-hash drift (PREVIEW_STALE unless force / ignore)
   *   * aggregate the captured input_snapshots into one audit payload
   *   * compute a combined chain-hash digest for the deploy row
   *
   * Returns the aggregated envelope. Throws AppError(PREVIEW_STALE) on
   * drift unless the caller explicitly opted out.
   */
  private async collectPreviewPinning(
    _pipelineId: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    nodes: any[],
    flags: { force: boolean; ignorePreviewSnapshot: boolean },
  ): Promise<{
    inputSnapshots: Record<string, unknown>;
    chainHashDigest: string | null;
    divergenceWarning: boolean;
    staleNodeIds: string[];
  }> {
    const { chainHashFromNodeConfig } = await import('./pipelines/previewSnapshot');
    const inputSnapshots: Record<string, unknown> = {};
    const staleNodeIds: string[] = [];
    const chainHashes: string[] = [];

    for (const n of nodes) {
      const cfg = typeof n.config === 'string'
        ? JSON.parse(n.config)
        : (n.config ?? {});
      const prev = cfg?.previewSnapshot;
      if (!prev) continue;
      // PB-B6 (d) — every previewed node contributes its input snapshot
      // to the audit map (the output node carries the transforms, the
      // dataset nodes carry the upstream pin).
      if (prev.inputSnapshot || prev.upstreamSnapshotId || prev.chainHash) {
        inputSnapshots[n.id] = {
          datasetId: n.dataset_id ?? prev.datasetId ?? null,
          upstreamSnapshotId: prev.upstreamSnapshotId ?? null,
          s3VersionId: prev.s3VersionId ?? null,
          etag: prev.etag ?? null,
          format: prev.format ?? null,
          chainHash: prev.chainHash ?? null,
          schemaFingerprint: prev.schemaFingerprint ?? null,
          capturedAt: prev.savedAt ?? prev.capturedAt ?? null,
          ...(prev.inputSnapshot ?? {}),
        };
      }
      const current = chainHashFromNodeConfig(cfg);
      if (prev.chainHash && prev.chainHash !== current) {
        staleNodeIds.push(n.id);
      }
      if (prev.chainHash) chainHashes.push(prev.chainHash);
    }

    if (staleNodeIds.length > 0 && !flags.force && !flags.ignorePreviewSnapshot) {
      const err = new AppError(
        `Deploy rejected: ${staleNodeIds.length} pipeline node(s) have a previewSnapshot ` +
          `whose chain hash no longer matches the live transforms. ` +
          `Re-preview the affected nodes or pass \`force: true\` in the body.`,
        409,
        'PREVIEW_STALE',
      );
      (err as unknown as { details?: unknown }).details = { staleNodeIds };
      throw err;
    }

    // PB-B6 spec literal: "If the upstream dataset has been deleted or
    // its snapshot expired (PB-B4 retention policy of 30 days), deploy
    // fails with PREVIEW_SNAPSHOT_EXPIRED". For every Iceberg-format
    // input we probe the catalog's snapshot list and confirm the pinned
    // snapshot_id is still present. The probe uses the shared sidecar —
    // same authority path the preview used to capture the pin — so a
    // race with the retention sweeper is caught here.
    if (!flags.ignorePreviewSnapshot) {
      const expiredNodeIds: string[] = [];
      for (const [nodeId, snap] of Object.entries(inputSnapshots)) {
        const s = snap as Record<string, unknown>;
        if (s.format !== 'iceberg') continue;
        const pinnedId = s.upstreamSnapshotId as string | null;
        const icebergRef = s.icebergRef as
          | { namespace: string; table: string; warehouse?: string }
          | undefined;
        if (!pinnedId || !icebergRef) continue;
        try {
          const { icebergSnapshots } = await import('./pipelines/icebergSidecar');
          const probe = await icebergSnapshots({
            namespace: icebergRef.namespace,
            table: icebergRef.table,
            warehouse: icebergRef.warehouse,
          });
          const present = probe.snapshots.some(
            (s2) => String(s2.snapshot_id) === String(pinnedId),
          );
          if (!present) expiredNodeIds.push(nodeId);
        } catch {
          /* probe best-effort; a flaky sidecar shouldn't block all deploys */
        }
      }
      if (expiredNodeIds.length > 0) {
        const err = new AppError(
          `Deploy rejected: ${expiredNodeIds.length} pipeline input(s) reference an ` +
            `Iceberg snapshot that has been expired by the retention sweeper. ` +
            `Re-preview the affected nodes or pass \`?ignorePreviewSnapshot=true\` to ` +
            `deploy against the latest upstream.`,
          409,
          'PREVIEW_SNAPSHOT_EXPIRED',
        );
        (err as unknown as { details?: unknown }).details = { expiredNodeIds };
        throw err;
      }
    }

    // `divergence_warning` on the deploy row means: the caller chose to
    // run against the live upstream rather than the captured pin. That's
    // driven by ?ignorePreviewSnapshot=true — force alone (chain-only
    // override) does NOT trip this flag.
    const divergenceWarning = flags.ignorePreviewSnapshot;

    // Composite chain-hash digest so a single column on the deployment
    // row can be correlated with the per-node chainHashes captured in
    // input_snapshots. We hash the SORTED list of node-level hashes so
    // the deploy of the same pipeline state yields the same digest.
    let chainHashDigest: string | null = null;
    if (chainHashes.length > 0) {
      const { createHash } = await import('crypto');
      chainHashDigest = createHash('sha256')
        .update(chainHashes.slice().sort().join('\n'), 'utf-8')
        .digest('hex');
    }

    return { inputSnapshots, chainHashDigest, divergenceWarning, staleNodeIds };
  }

  /**
   * PB-B8 — on deploy completion, record (output → inputs)
   * `pipeline_output` edges and fire Funnel signals for every Object
   * Type whose backing_datasource matches the new output dataset.
   *
   * Fingerprint: `${deploymentId}-${ontologyId}-${objectTypeApiName}`.
   * Combined with `funnel_signal.signal_fingerprint_unique` this gives
   * acceptance (e) — two deploys in quick succession against the same
   * dataset enqueue at most ONE Funnel signal per OT.
   */
  private async applyDeployLineageAndSignals(input: {
    pipelineId: string;
    deploymentId: string;
    outputDatasetId: string;
    sourceTransactionId: string;
  }): Promise<void> {
    if (!input.outputDatasetId) return;
    const { DatasetLineageService } = await import('./pipelines/datasetLineage');
    const lineage = new DatasetLineageService(this.knex);

    // 1. Insert pipeline_output edges for every dataset-bound input node.
    const inputDatasets = (await this.knex('pipeline_nodes')
      .where({ pipeline_id: input.pipelineId })
      .whereNotNull('dataset_id')
      .whereNot('node_type', 'output')
      .distinct('dataset_id')
      .pluck('dataset_id')) as string[];
    for (const upstreamId of inputDatasets) {
      if (!upstreamId || upstreamId === input.outputDatasetId) continue;
      try {
        await lineage.insertEdge({
          downstreamDatasetId: input.outputDatasetId,
          upstreamDatasetId: upstreamId,
          edgeType: 'pipeline_output',
          metadata: {
            pipelineId: input.pipelineId,
            deploymentId: input.deploymentId,
          },
        });
      } catch (err) {
        // Cycle rejection is the only expected failure here; log and
        // continue so a single pathological edge doesn't block the
        // other auto-fire targets.
        console.warn(
          `[deploy] lineage insert skipped: ${(err as Error).message}`,
        );
      }
    }

    // 2. Walk downstream — for every OT whose backing_datasource is
    // this output dataset, fire the Funnel signal with a deduping
    // fingerprint. PB-B8 follow-fnl-h3 also fires a dedicated
    // `pipelineDeployCompleted` signal so consumers that want pipeline-
    // event semantics subscribe to it directly instead of filtering
    // generic source-transaction signals. Both are fingerprinted on
    // `${deploymentId}-${ontology}-${ot}` so replaying the deploy is
    // a no-op at the Funnel boundary for either type.
    const ots = await lineage.findObjectTypesFor(input.outputDatasetId);
    if (ots.length === 0) return;
    const { sendSignal } = await import('./funnel/durableWorkflow');
    for (const ot of ots) {
      const fingerprint = `${input.deploymentId}-${ot.ontologyId}-${ot.objectTypeApiName}`;
      const commonPayload = {
        datasourceId: ot.datasourceId,
        sourceTransactionId: input.sourceTransactionId,
        idempotencyKey: fingerprint,
        originDeploymentId: input.deploymentId,
        originPipelineId: input.pipelineId,
      };
      try {
        await sendSignal({
          ontologyId: ot.ontologyId,
          objectTypeApiName: ot.objectTypeApiName,
          signalType: 'sourceTransactionCommitted',
          payload: commonPayload,
          fingerprint,
        });
      } catch (err) {
        console.warn(
          `[deploy] sendSignal(${ot.objectTypeApiName}, sourceTransactionCommitted) failed: ${(err as Error).message}`,
        );
      }
      // PB-B8 follow-fnl-h3 — second signal, separate fingerprint so
      // the two signal types don't collide on the partial-unique index.
      try {
        await sendSignal({
          ontologyId: ot.ontologyId,
          objectTypeApiName: ot.objectTypeApiName,
          signalType: 'pipelineDeployCompleted',
          payload: commonPayload,
          fingerprint: `pdc:${fingerprint}`,
        });
      } catch (err) {
        console.warn(
          `[deploy] sendSignal(${ot.objectTypeApiName}, pipelineDeployCompleted) failed: ${(err as Error).message}`,
        );
      }
    }
  }

  /**
   * PB-B10 — after a successful deploy lands a new dataset snapshot,
   * update the last_output_schema_fingerprint and, when the schema
   * actually changed, fire a Funnel `schemaChanged` signal per
   * backing Object Type. Delegates OT resolution to the same lineage
   * walker used by PB-B8.
   */
  private async applySchemaEvolutionPostDeploy(input: {
    pipelineId: string;
    deploymentId: string;
    outputDatasetId: string | null;
    currentColumns: Array<{ name: string; type: string }>;
  }): Promise<void> {
    if (!input.outputDatasetId) return;
    const { fingerprintOutputSchema, diffOutputSchema } = await import(
      './pipelines/schemaEvolution'
    );
    const row = await this.knex('foundry_datasets')
      .where({ id: input.outputDatasetId })
      .first('last_output_schema_fingerprint');
    const priorFingerprint = row?.last_output_schema_fingerprint ?? null;
    const currentSchema = input.currentColumns.map((c) => ({
      name: c.name,
      type: c.type,
      required: false,
      primaryKey: false,
    }));
    const newFingerprint = fingerprintOutputSchema(currentSchema);
    // Update the persisted fingerprint regardless — subsequent deploys
    // diff against whatever the last successful deploy left behind.
    await this.knex('foundry_datasets')
      .where({ id: input.outputDatasetId })
      .update({ last_output_schema_fingerprint: newFingerprint });
    if (priorFingerprint === null || priorFingerprint === newFingerprint) {
      return; // no drift, nothing to signal
    }

    // Compute the concrete op list so the signal payload carries the
    // Funnel's schema_diff context. Prior columns are read from
    // dataset_columns snapshot-before-this-deploy (already refreshed
    // above by executeBuild but the ordering in that flow means we're
    // reading the POST state; for an honest diff we skip this best-
    // effort — the Funnel only needs to know it changed + the new
    // fingerprint to create the next Quickwit version).
    const diff = diffOutputSchema(null, currentSchema);

    const { DatasetLineageService } = await import('./pipelines/datasetLineage');
    const lineage = new DatasetLineageService(this.knex);
    const ots = await lineage.findObjectTypesFor(input.outputDatasetId);
    if (ots.length === 0) return;
    const { sendSignal } = await import('./funnel/durableWorkflow');
    for (const ot of ots) {
      const fingerprint = `schema:${input.deploymentId}-${ot.ontologyId}-${ot.objectTypeApiName}`;
      try {
        await sendSignal({
          ontologyId: ot.ontologyId,
          objectTypeApiName: ot.objectTypeApiName,
          signalType: 'schemaChanged',
          payload: {
            source_pipeline_deployment_id: input.deploymentId,
            source_pipeline_id: input.pipelineId,
            datasource_id: ot.datasourceId,
            schema_diff: diff.operations,
            new_schema_fingerprint: newFingerprint,
            prior_schema_fingerprint: priorFingerprint,
          },
          fingerprint,
        });
      } catch (err) {
        console.warn(
          `[deploy] sendSignal(schemaChanged, ${ot.objectTypeApiName}) failed: ${(err as Error).message}`,
        );
      }
    }
  }

  /**
   * PB-B10 — compute the output-schema evolution envelope for a
   * pipeline's output nodes. Uses the first output node (multi-output
   * pipelines are tracked as `PB-B10.follow-multi-output`) — the
   * pattern in this codebase is one canonical output per pipeline.
   *
   * Returns the classified diff + both fingerprints. Callers decide
   * whether to proceed (safe) or reject (unsafe) based on the admin
   * override flags.
   */
  private async computeSchemaEvolutionForOutputs(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    outputNodes: any[],
  ): Promise<{
    changed: boolean;
    priorFingerprint: string | null;
    newFingerprint: string;
    willBeSafe: boolean;
    operations: Array<Record<string, unknown>>;
    blockingIssues: Array<Record<string, unknown>>;
    outputDatasetId: string | null;
    currentColumns: Array<{ name: string; type: string; required?: boolean; primaryKey?: boolean }>;
  }> {
    const { classifyEvolution, fingerprintOutputSchema } = await import('./pipelines/schemaEvolution');
    if (outputNodes.length === 0) {
      return {
        changed: false,
        priorFingerprint: null,
        newFingerprint: fingerprintOutputSchema([]),
        willBeSafe: true,
        operations: [],
        blockingIssues: [],
        outputDatasetId: null,
        currentColumns: [],
      };
    }
    const out = outputNodes[0];
    const cfg = typeof out.config === 'string' ? JSON.parse(out.config) : out.config ?? {};
    const currentColumns = Array.isArray(cfg.columns)
      ? cfg.columns.map((c: { name: string; type: string; required?: boolean; primaryKey?: boolean }) => ({
          name: c.name,
          type: c.type ?? 'string',
          required: c.required ?? false,
          primaryKey: c.primaryKey ?? false,
        }))
      : [];
    const outputDatasetId: string | null =
      out.dataset_id ?? cfg.outputDatasetId ?? null;
    let priorFingerprint: string | null = null;
    let priorColumns: Array<{ name: string; type: string; required?: boolean; primaryKey?: boolean }> | null = null;
    if (outputDatasetId) {
      const row = await this.knex('foundry_datasets')
        .where({ id: outputDatasetId })
        .first('last_output_schema_fingerprint');
      priorFingerprint = row?.last_output_schema_fingerprint ?? null;
      const cols = await this.knex('dataset_columns')
        .where({ dataset_id: outputDatasetId })
        .orderBy('ordinal_position', 'asc')
        .select('column_name', 'column_type', 'nullable');
      priorColumns = cols.map((c: { column_name: string; column_type: string; nullable: boolean }) => ({
        name: c.column_name,
        type: c.column_type,
        required: c.nullable === false,
        primaryKey: false,
      }));
    }
    const res = classifyEvolution(priorColumns, currentColumns, priorFingerprint);
    return {
      changed: res.changed,
      priorFingerprint: res.priorFingerprint,
      newFingerprint: res.newFingerprint,
      willBeSafe: res.willBeSafe,
      operations: res.operations as unknown as Array<Record<string, unknown>>,
      blockingIssues: res.blockingIssues as unknown as Array<Record<string, unknown>>,
      outputDatasetId,
      currentColumns,
    };
  }

  private async isCancellationRequested(deploymentId: string): Promise<boolean> {
    const row = await this.knex('pipeline_deployments')
      .where({ id: deploymentId })
      .first('cancellation_requested_at');
    return !!row?.cancellation_requested_at;
  }

  /**
   * PB-B6 — read every dataset-input node at its captured pin and seed
   * the transformService's pinned-input cache. The deploy's downstream
   * chain reads from the cache rather than from the live upstream, so
   * a concurrent writer appending to the input between preview and
   * deploy cannot leak into the deploy output.
   *
   * For Iceberg inputs we scan the pinned snapshot via the PyIceberg
   * sidecar (same subprocess the preview used). For S3-versioned
   * inputs we stream via `getObjectStreamPinned(versionId, etag)` and
   * parse the CSV inline. Unpinned inputs are left alone — readCsvRows
   * falls back to the live stream.
   */
  private async seedPinnedInputsForDeploy(
    _projectId: string,
    pipelineId: string,
  ): Promise<void> {
    this.transformService.clearPinnedInputCache();
    // PB-B6 — every node that carries a previewSnapshot is a potential
    // pin point. Dataset leaves have a direct `dataset_id`; Join/Union
    // nodes reference transitively via their sourceNodeId/leftNodeId/
    // rightNodeId. We join foundry_datasets loosely so non-dataset
    // nodes still appear; the row filter below trims to entries we can
    // actually pin (file_path present + pin coordinates captured).
    const datasetNodes = await this.knex('pipeline_nodes as pn')
      .leftJoin('foundry_datasets as fd', 'pn.dataset_id', 'fd.id')
      .where({ 'pn.pipeline_id': pipelineId })
      .select(
        'pn.id as node_id',
        'pn.node_type as node_type',
        'pn.config',
        'pn.dataset_id',
        'fd.file_path as file_path',
        'fd.format as format',
      );

    for (const node of datasetNodes) {
      const cfg = typeof node.config === 'string'
        ? JSON.parse(node.config)
        : (node.config ?? {});
      const prev = cfg?.previewSnapshot;
      // Transitive Join/Union nodes keep their pin in
      // previewSnapshot.inputs[] — each entry is a { datasetId,
      // file_path, format, upstreamSnapshotId | s3VersionId | etag }
      // tuple captured at preview time. When present, seed the cache
      // for every such entry; otherwise use the (legacy) leaf-node
      // single-pin path below.
      if (prev && Array.isArray(prev.inputs) && prev.inputs.length > 0) {
        for (const entry of prev.inputs) {
          if (!entry?.file_path) continue;
          const transitive = {
            format: entry.format as string | undefined,
            file_path: entry.file_path as string,
            dataset_id: entry.datasetId ?? entry.dataset_id ?? null,
            pinnedId: entry.upstreamSnapshotId as string | null,
            versionId: entry.s3VersionId as string | null,
            etag: entry.etag as string | null,
            icebergRef: entry.icebergRef,
          };
          await this.seedOnePinnedInput(transitive);
        }
        continue;
      }
      if (!prev || !node.file_path) continue;

      const pinnedId = prev.upstreamSnapshotId as string | null;
      const versionId = prev.s3VersionId as string | null;
      const etag = prev.etag as string | null;

      // Iceberg-pinned input: scan at the captured snapshot. The
      // per-call row cap (default 10M, override via
      // PB_B6_ICEBERG_SCAN_LIMIT) is intentionally generous for prod
      // but bounded so a runaway upstream can't balloon the pod's heap.
      // When a scan saturates the cap we log a WARNING — silent
      // truncation would violate PB-B6 acceptance (a).
      if (node.format === 'iceberg' && pinnedId && prev.icebergRef) {
        try {
          const { icebergScanAsOf } = await import('./pipelines/icebergSidecar');
          const ref = prev.icebergRef as {
            warehouse?: string;
            namespace: string;
            table: string;
          };
          const scanLimit = Math.max(
            100_000,
            Number(process.env.PB_B6_ICEBERG_SCAN_LIMIT ?? 10_000_000),
          );
          const scan = await icebergScanAsOf({
            warehouse: ref.warehouse,
            namespace: ref.namespace,
            table: ref.table,
            snapshotId: pinnedId,
            limit: scanLimit,
          });
          if (scan.row_count >= scanLimit) {
            console.warn(
              `[deploy] WARNING: iceberg-pinned read for ${node.dataset_id} ` +
                `saturated the ${scanLimit}-row cap — deploy output may be ` +
                `truncated. Raise PB_B6_ICEBERG_SCAN_LIMIT or partition the ` +
                `input table.`,
            );
          }
          const rows = scan.rows.map((r) => {
            const out: Record<string, string> = {};
            for (const [k, v] of Object.entries(r)) {
              out[k] = v === null || v === undefined ? '' : String(v);
            }
            return out;
          });
          this.transformService.setPinnedInputRows(node.file_path, rows);
          continue;
        } catch (err) {
          const msg = (err as Error).message;
          if (/snapshot.*not found|no such snapshot|404/i.test(msg)) {
            const expired = new AppError(
              `Input ${node.dataset_id} is pinned to Iceberg snapshot ${pinnedId} ` +
                `which no longer exists (expired by retention sweeper).`,
              409,
              'PREVIEW_SNAPSHOT_EXPIRED',
            );
            (expired as unknown as { details?: unknown }).details = {
              datasetId: node.dataset_id,
              snapshotId: pinnedId,
            };
            throw expired;
          }
          throw err;
        }
      }

      // S3-versioned input: stream at the captured VersionId / ETag.
      if (versionId || etag) {
        try {
          const { getObjectStreamPinned } = await import('./storageService');
          const { parse } = await import('csv-parse');
          const stream = await getObjectStreamPinned(node.file_path, {
            versionId: versionId ?? null,
            etag: etag ?? null,
          });
          // Bounded read: cap the in-memory buffer so a 10GB CSV can't
          // OOM the API pod. PB_B6_S3_ROW_CAP (default 10M) matches the
          // Iceberg scan cap. Saturation logs a warning so silent
          // truncation is loud.
          const s3RowCap = Math.max(
            100_000,
            Number(process.env.PB_B6_S3_ROW_CAP ?? 10_000_000),
          );
          let truncated = false;
          const rows = await new Promise<Array<Record<string, string>>>(
            (resolve, reject) => {
              const acc: Array<Record<string, string>> = [];
              const parser = parse({
                delimiter: node.file_path.endsWith('.tsv') ? '\t' : ',',
                columns: true,
                skip_empty_lines: true,
                trim: true,
                relax_column_count: true,
                bom: true,
              });
              parser.on('readable', () => {
                let rec: Record<string, string>;
                while ((rec = parser.read()) !== null) {
                  acc.push(rec);
                  if (acc.length >= s3RowCap) {
                    truncated = true;
                    parser.destroy();
                    resolve(acc);
                    return;
                  }
                }
              });
              parser.on('error', reject);
              parser.on('end', () => resolve(acc));
              stream.pipe(parser);
            },
          );
          if (truncated) {
            console.warn(
              `[deploy] WARNING: S3-pinned read for ${node.file_path} ` +
                `saturated ${s3RowCap}-row cap — deploy output may be ` +
                `truncated. Raise PB_B6_S3_ROW_CAP or migrate input to Iceberg.`,
            );
          }
          this.transformService.setPinnedInputRows(node.file_path, rows);
        } catch (err) {
          const code = (err as { code?: string }).code;
          if (code === 'PREVIEW_SNAPSHOT_EXPIRED') throw err;
          // Non-fatal: readCsvRows falls back to live read if cache
          // wasn't seeded for this path.
          console.warn(
            `[deploy] S3-pinned read failed for ${node.file_path}: ` +
              `${(err as Error).message}`,
          );
        }
      }
    }
  }

  /**
   * PB-B6 — pin a single input (leaf or transitive). Factored out so
   * Join/Union nodes with `previewSnapshot.inputs[]` can honour every
   * contributing upstream, not just the top-level leaf.
   */
  private async seedOnePinnedInput(entry: {
    format?: string;
    file_path: string;
    dataset_id: string | null;
    pinnedId: string | null;
    versionId: string | null;
    etag: string | null;
    icebergRef?: { warehouse?: string; namespace: string; table: string };
  }): Promise<void> {
    if (entry.format === 'iceberg' && entry.pinnedId && entry.icebergRef) {
      const { icebergScanAsOf } = await import('./pipelines/icebergSidecar');
      const scanLimit = Math.max(
        100_000,
        Number(process.env.PB_B6_ICEBERG_SCAN_LIMIT ?? 10_000_000),
      );
      try {
        const scan = await icebergScanAsOf({
          warehouse: entry.icebergRef.warehouse,
          namespace: entry.icebergRef.namespace,
          table: entry.icebergRef.table,
          snapshotId: entry.pinnedId,
          limit: scanLimit,
        });
        if (scan.row_count >= scanLimit) {
          console.warn(
            `[deploy] iceberg scan for ${entry.dataset_id} saturated cap ${scanLimit}`,
          );
        }
        const rows = scan.rows.map((r) => {
          const out: Record<string, string> = {};
          for (const [k, v] of Object.entries(r)) {
            out[k] = v === null || v === undefined ? '' : String(v);
          }
          return out;
        });
        this.transformService.setPinnedInputRows(entry.file_path, rows);
      } catch (err) {
        const msg = (err as Error).message;
        if (/snapshot.*not found|no such snapshot|404/i.test(msg)) {
          const expired = new AppError(
            `Transitive input ${entry.dataset_id} is pinned to Iceberg snapshot ` +
              `${entry.pinnedId} which no longer exists.`,
            409,
            'PREVIEW_SNAPSHOT_EXPIRED',
          );
          throw expired;
        }
        throw err;
      }
      return;
    }
    if (entry.versionId || entry.etag) {
      const { getObjectStreamPinned } = await import('./storageService');
      const { parse } = await import('csv-parse');
      const stream = await getObjectStreamPinned(entry.file_path, {
        versionId: entry.versionId ?? null,
        etag: entry.etag ?? null,
      });
      const s3RowCap = Math.max(
        100_000,
        Number(process.env.PB_B6_S3_ROW_CAP ?? 10_000_000),
      );
      const rows = await new Promise<Array<Record<string, string>>>(
        (resolve, reject) => {
          const acc: Array<Record<string, string>> = [];
          const parser = parse({
            delimiter: entry.file_path.endsWith('.tsv') ? '\t' : ',',
            columns: true,
            skip_empty_lines: true,
            trim: true,
            relax_column_count: true,
            bom: true,
          });
          parser.on('readable', () => {
            let rec: Record<string, string>;
            while ((rec = parser.read()) !== null) {
              acc.push(rec);
              if (acc.length >= s3RowCap) {
                parser.destroy();
                resolve(acc);
                return;
              }
            }
          });
          parser.on('error', reject);
          parser.on('end', () => resolve(acc));
          stream.pipe(parser);
        },
      );
      this.transformService.setPinnedInputRows(entry.file_path, rows);
    }
  }

  private async finaliseCancelled(
    deploymentId: string,
    buildResults: BuildResult[],
  ): Promise<void> {
    const now = new Date();
    const row = await this.knex('pipeline_deployments')
      .where({ id: deploymentId })
      .first('pipeline_id', 'started_at');
    await this.knex('pipeline_deployments')
      .where({ id: deploymentId })
      .update({
        status: 'cancelled',
        finished_at: now.toISOString(),
        build_results: JSON.stringify(buildResults),
        error_message: 'cancelled_by_user',
      });
    // PB-B9 — deploy duration histogram carries the 'cancelled' status
    // so the SLO dashboard can separate user-cancel from failed work.
    if (row?.started_at && row?.pipeline_id) {
      const startedMs =
        row.started_at instanceof Date
          ? row.started_at.getTime()
          : Date.parse(String(row.started_at));
      const seconds = (now.getTime() - startedMs) / 1000;
      recordDeployDuration(row.pipeline_id, 'cancelled', Math.max(0, seconds));
    }
  }

  /**
   * Background build execution — runs after startDeployment returns.
   * Updates the deployment record as builds complete.
   */
  private async executeBuild(
    projectId: string,
    pipelineId: string,
    deploymentId: string,
    triggeredBy: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    outputNodes: any[],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    pipeline: any,
  ): Promise<void> {
    const startedAt = Date.now();
    const buildResults: BuildResult[] = [];
    // PB-B9 — pipeline_active_deploys gauge. Increments on entry,
    // decrements when the deploy row lands in a terminal state
    // (succeeded/failed/cancelled) regardless of which branch we exit
    // through.
    incActiveDeploys(1);
    let metricsDecremented = false;
    const decrementOnExit = () => {
      if (!metricsDecremented) {
        metricsDecremented = true;
        incActiveDeploys(-1);
      }
    };

    // PB-B6 — seed the transformService's pinned-input cache so every
    // downstream readCsvRows honours the snapshot captured at preview
    // time instead of reading the live upstream. Iceberg inputs go via
    // icebergScanAsOf(snapshot_id=...); S3-versioned inputs go via
    // getObjectStreamPinned(versionId, etag). This makes acceptance (a)
    // — "deploy sees ORIGINAL rows, not new ones written post-preview"
    // — literally true rather than audit-only.
    try {
      await this.seedPinnedInputsForDeploy(projectId, pipelineId);
    } catch (err) {
      // Surface PREVIEW_SNAPSHOT_EXPIRED / INPUT_NOT_VERSIONED cleanly.
      // Anything else is swallowed so a flaky pin probe never blocks a
      // deploy that could otherwise succeed on a degraded pin.
      const code = (err as { code?: string }).code;
      if (
        code === 'PREVIEW_SNAPSHOT_EXPIRED' ||
        code === 'INPUT_NOT_VERSIONED'
      ) {
        decrementOnExit();
        throw err;
      }
      console.warn(
        `[deploy] pinned-input seed failed: ${(err as Error).message}; ` +
          `falling back to live read`,
      );
    }

    for (const outputNode of outputNodes) {
      // PB-B1 cooperative cancellation: check before each output so an
      // in-flight DELETE /deployments/:id takes effect within the time
      // of the current output (upper-bounded by outputPreview + upload).
      if (await this.isCancellationRequested(deploymentId)) {
        await this.finaliseCancelled(deploymentId, buildResults);
        decrementOnExit();
        return;
      }
      const buildStart = Date.now();
      const cfg = typeof outputNode.config === 'string'
        ? JSON.parse(outputNode.config)
        : (outputNode.config ?? {});

      try {
        // Resolve upstream data
        let data: { columns: Array<{ name: string; type: string }>; rows: Array<Record<string, unknown>>; totalRows: number };
        try {
          data = await this.transformService.outputPreview(
            projectId, pipelineId, outputNode.id, 100_000,
          );
        } catch (resolveErr) {
          const msg = resolveErr instanceof Error ? resolveErr.message : String(resolveErr);
          if (msg.includes('NO_DATASET') || msg.includes('no associated dataset')) {
            throw new Error(
              `Cannot build "${outputNode.label}": upstream join/union node hasn't been applied. ` +
              `Open the join/union node and click "Apply" before deploying.`
            );
          }
          throw resolveErr;
        }

        if (data.rows.length === 0) {
          throw new Error('Upstream chain produced zero rows');
        }

        // PB-B3 — branch on the pipeline's output_format. CSV path is
        // preserved byte-identically for backwards compatibility (spec
        // acceptance (b)); Parquet path goes through DuckDB COPY with
        // ZSTD + 100k row-group size per the spec.
        const outputFormat = (pipeline.output_format ?? 'csv') as 'csv' | 'parquet' | 'iceberg';
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const safeName = outputNode.label.replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase();

        let s3Key: string;
        let fileSizeBytes: number;
        let mimeType: string;
        let rowCountExact: number | null = null;
        let logicalTypesByColumn: Map<string, string> | null = null;
        let parquetStagedPath: string | null = null;

        if (outputFormat === 'iceberg') {
          // PB-B4 — Iceberg writes via the PyIceberg sidecar. We stage
          // Parquet locally with the PB-B3 writer, hand the file path to
          // the sidecar which does:
          //   * create-or-get the table under _pipeline.<proj>.<pipe>.output
          //   * capture prior_snapshot_id (for cancellation rollback)
          //   * append the Parquet as a new snapshot with OCC retry
          // The resulting snapshot id is recorded on pipeline_deployments.
          if (!(await icebergSidecarAvailable())) {
            throw new AppError(
              "PyIceberg sidecar is not available — ensure `python3` + `pyiceberg` are installed on the API pod, or fall back to output_format='parquet'.",
              503,
              'ICEBERG_SIDECAR_UNAVAILABLE',
            );
          }
          // Validate partition spec against the output schema. Throws
          // ICEBERG_PARTITION_SPEC_INVALID with details.reasons if bad.
          const rawSpec =
            typeof pipeline.iceberg_partition_spec === 'string'
              ? JSON.parse(pipeline.iceberg_partition_spec)
              : pipeline.iceberg_partition_spec ?? null;
          const partitionSpec = validatePartitionSpec(rawSpec, data.columns);

          const projectSlug = slugForNamespace(`proj_${projectId.replace(/-/g, '').slice(0, 12)}`);
          const pipelineSlug = slugForNamespace(
            `${(pipeline.name ?? 'pipe').toString()}_${pipelineId.replace(/-/g, '').slice(0, 8)}`,
          );
          // PB-B4 — ensure the _pipeline warehouse + namespace exist via
          // the SHARED funnel/lakekeeperClient (no parallel catalog
          // client). This delegates into pipelines/lakekeeperBootstrap
          // which reuses getLakekeeperClient() from funnel/.
          const {
            ensurePipelineNamespace,
            pipelineWarehouseName,
          } = await import('./pipelines/lakekeeperBootstrap');
          const warehouse = pipelineWarehouseName();
          const namespace = await ensurePipelineNamespace(projectSlug, pipelineSlug);
          const table = PIPELINE_LEAF_TABLE;

          // 1. Create-or-get the Iceberg table; capture prior snapshot for
          // cancellation rollback. If the cancel signal lands before the
          // append commit, we rollback_to_snapshot(prior) and leave the
          // table untouched.
          const created = await icebergCreateOrGet({
            warehouse,
            namespace,
            table,
            columns: data.columns,
            partitionSpec: partitionSpec.map((p) => ({
              column: p.column,
              transform: p.transform,
              n: p.n,
              name: p.name,
            })),
          });
          const priorSnapshotId = created.snapshotId;

          // 2. Stage the Parquet locally; same writer as the CSV/Parquet
          // path so logical types + ZSTD + 100k row-group size land.
          const parquet = await writeRowsToParquet({
            columns: data.columns,
            rows: data.rows,
          });
          parquetStagedPath = parquet.localPath;
          fileSizeBytes = parquet.sizeBytes;
          rowCountExact = parquet.rowCountExact;
          logicalTypesByColumn = new Map(
            parquet.columnLogicalTypes.map((c) => [c.name, c.logicalType]),
          );
          mimeType = 'application/vnd.apache.iceberg';

          // 3. Record the table + prior snapshot so cancellation works
          // from this moment on.
          await this.knex('pipeline_deployments')
            .where({ id: deploymentId })
            .update({
              output_table_location: `${warehouse}:${namespace}.${table}`,
              prior_snapshot_id: priorSnapshotId,
            });

          // 4. PB-B10 — apply schema evolution BEFORE data write. The
          // migration runs in the same sidecar transaction; Iceberg
          // metadata transactions are independent of data files so a
          // downstream data-write failure can still rollback via
          // rollback_to_snapshot(priorSnapshotId) without leaving
          // orphan metadata. Only safe ops are applied here — unsafe
          // diffs were already rejected (or force-admitted) in
          // startDeployment.
          const existingDatasetIdForSchema = cfg.outputDatasetId as string | undefined;
          try {
            const { classifyEvolution } = await import('./pipelines/schemaEvolution');
            const priorCols = existingDatasetIdForSchema
              ? await this.knex('dataset_columns')
                  .where({ dataset_id: existingDatasetIdForSchema })
                  .orderBy('ordinal_position', 'asc')
                  .select('column_name', 'column_type', 'nullable')
              : [];
            const priorSchema = priorCols.map((c: { column_name: string; column_type: string; nullable: boolean }) => ({
              name: c.column_name,
              type: c.column_type,
              required: c.nullable === false,
            }));
            const currSchema = data.columns.map((c) => ({ name: c.name, type: c.type ?? 'string' }));
            const priorFp = existingDatasetIdForSchema
              ? (
                  await this.knex('foundry_datasets')
                    .where({ id: existingDatasetIdForSchema })
                    .first('last_output_schema_fingerprint')
                )?.last_output_schema_fingerprint ?? null
              : null;
            const evol = classifyEvolution(
              priorCols.length > 0 ? priorSchema : null,
              currSchema,
              priorFp,
            );
            if (evol.changed && evol.willBeSafe && evol.safeOperations.length > 0) {
              const { icebergUpdateSchema } = await import('./pipelines/icebergSidecar');
              await icebergUpdateSchema({
                warehouse,
                namespace,
                table,
                operations: evol.safeOperations as Parameters<typeof icebergUpdateSchema>[0]['operations'],
              });
            }
          } catch (err) {
            // Metadata-transaction failure = bail before data write so we
            // don't leave a half-evolved table. Rollback is a no-op when
            // priorSnapshotId is null (fresh table).
            console.warn(
              `[deploy] iceberg update_schema failed: ${(err as Error).message}`,
            );
            if (priorSnapshotId) {
              try {
                await icebergRollback({
                  warehouse,
                  namespace,
                  table,
                  targetSnapshotId: priorSnapshotId,
                });
              } catch {
                /* ignore rollback failure */
              }
            }
            throw err;
          }

          // 5. Cooperative cancellation check — if the caller DELETE'd
          // between create_or_get/update_schema and append, bail cleanly
          // now; no data has been appended yet.
          if (await this.isCancellationRequested(deploymentId)) {
            discardStagedParquet(parquet.localPath);
            parquetStagedPath = null;
            await this.finaliseCancelled(deploymentId, buildResults);
            decrementOnExit();
            return;
          }

          // 6. Append with OCC retry. 5 attempts × exponential backoff.
          // On data-write failure we rollback the Iceberg metadata
          // transaction that the update_schema step committed.
          let appendRes: Awaited<ReturnType<typeof icebergAppend>>;
          try {
            appendRes = await icebergAppend({
              warehouse,
              namespace,
              table,
              parquetFiles: [parquet.localPath],
            });
          } catch (err) {
            if (priorSnapshotId) {
              try {
                await icebergRollback({
                  warehouse,
                  namespace,
                  table,
                  targetSnapshotId: priorSnapshotId,
                });
              } catch {
                /* ignore */
              }
            }
            throw err;
          }
          const newSnapshotId = appendRes.snapshotId;
          discardStagedParquet(parquet.localPath);
          parquetStagedPath = null;

          // 6. Final cancellation defence — if DELETE arrived during the
          // retries, rollback to the prior snapshot and exit.
          if (await this.isCancellationRequested(deploymentId)) {
            if (newSnapshotId && priorSnapshotId) {
              try {
                await icebergRollback({
                  warehouse,
                  namespace,
                  table,
                  targetSnapshotId: priorSnapshotId,
                });
              } catch (err) {
                console.warn(
                  `[deploy] iceberg rollback failed: ${(err as Error).message}`,
                );
              }
            }
            await this.finaliseCancelled(deploymentId, buildResults);
            decrementOnExit();
            return;
          }

          // 7. Record snapshot id + retry count for observability.
          await this.knex('pipeline_deployments')
            .where({ id: deploymentId })
            .update({
              output_snapshot_id: newSnapshotId,
              iceberg_retry_count: appendRes.attempts - 1,
            });

          // Point the dataset file_path at the catalog location so
          // downstream Funnel readers can resolve the table identity.
          s3Key = `${warehouse}/${namespace}/${table}#snapshot=${newSnapshotId}`;
        } else

        if (outputFormat === 'parquet') {
          // Directory-as-dataset pattern — PB-B3 spec: {name}_{ts}/part-00000.parquet.
          // Downstream readers treat the dataset as a directory so PB-B4
          // can drop multi-file Parquet + an Iceberg manifest in the
          // same prefix without breaking URL semantics.
          s3Key = `projects/${projectId}/pipeline-outputs/${pipelineId}/${safeName}_${timestamp}/part-00000.parquet`;
          const parquet = await writeRowsToParquet({
            columns: data.columns,
            rows: data.rows,
          });
          parquetStagedPath = parquet.localPath;
          fileSizeBytes = parquet.sizeBytes;
          rowCountExact = parquet.rowCountExact;
          logicalTypesByColumn = new Map(
            parquet.columnLogicalTypes.map((c) => [c.name, c.logicalType]),
          );
          const bytes = fs.readFileSync(parquet.localPath);
          mimeType = 'application/vnd.apache.parquet';
          await uploadObject(s3Key, bytes, mimeType, {
            pipelineId,
            nodeId: outputNode.id,
            deploymentId,
          });
          // Staging file is only useful for upload retry — discard after
          // a successful upload so we don't leak tmp space.
          discardStagedParquet(parquet.localPath);
          parquetStagedPath = null;
        } else {
          // CSV path — unchanged from pre-PB-B3 for byte-identical output.
          const csvBuffer = rowsToCsvBuffer(data.columns, data.rows);
          s3Key = `projects/${projectId}/pipeline-outputs/${pipelineId}/${safeName}_${timestamp}.csv`;
          fileSizeBytes = csvBuffer.length;
          mimeType = 'text/csv';
          await uploadObject(s3Key, csvBuffer, mimeType, {
            pipelineId,
            nodeId: outputNode.id,
            deploymentId,
          });
        }

        // Create or update output dataset
        let datasetId: string;
        const existingDatasetId = cfg.outputDatasetId as string | undefined;

        const datasetFormat =
          outputFormat === 'iceberg'
            ? 'iceberg'
            : outputFormat === 'parquet'
            ? 'parquet'
            : 'csv';
        const originalFilename =
          outputFormat === 'iceberg'
            ? `${safeName}.iceberg`
            : outputFormat === 'parquet'
            ? `${safeName}/part-00000.parquet`
            : `${safeName}.csv`;

        if (existingDatasetId) {
          await this.knex('foundry_datasets')
            .where({ id: existingDatasetId })
            .update({
              file_path: s3Key,
              row_count: data.rows.length,
              row_count_exact: rowCountExact,
              column_count: data.columns.length,
              file_size_bytes: fileSizeBytes,
              mime_type: mimeType,
              format: datasetFormat,
              original_filename: originalFilename,
              status: 'ready',
              updated_by: triggeredBy,
            });
          datasetId = existingDatasetId;
          await this.knex('dataset_columns').where({ dataset_id: datasetId }).del();
        } else {
          const [newDataset] = await this.knex('foundry_datasets')
            .insert({
              name: outputNode.label,
              project_id: projectId,
              file_path: s3Key,
              original_filename: originalFilename,
              mime_type: mimeType,
              format: datasetFormat,
              file_size_bytes: fileSizeBytes,
              row_count: data.rows.length,
              row_count_exact: rowCountExact,
              column_count: data.columns.length,
              status: 'ready',
              created_by: triggeredBy,
              updated_by: triggeredBy,
            })
            .returning('*');
          datasetId = newDataset.id;

          await this.knex('pipeline_nodes')
            .where({ id: outputNode.id })
            .update({
              dataset_id: datasetId,
              config: JSON.stringify({ ...cfg, outputDatasetId: datasetId }),
            });
        }

        // Insert column schema (with Parquet logical type when applicable)
        const columnRows = data.columns.map((col, idx) => ({
          dataset_id: datasetId,
          column_name: col.name,
          column_type: col.type || 'text',
          ordinal_position: idx + 1,
          nullable: true,
          logical_type:
            logicalTypesByColumn?.get(col.name) ??
            (outputFormat === 'parquet' || outputFormat === 'iceberg'
              ? pipelineTypeToParquetLogicalType(col.type ?? 'string')
              : null),
        }));
        if (columnRows.length > 0) {
          await this.knex('dataset_columns').insert(columnRows);
        }

        // PB-B7 — stamp the output dataset with the union of input
        // markings captured at deploy-start. Union is already on the
        // pipeline row (input_markings); read it back so we don't
        // recompute here. Without this the output dataset would carry
        // NO markings and a downstream consumer could read it without
        // the clearances the source data requires.
        const pipeMarkings = await this.knex('pipelines')
          .where({ id: pipelineId })
          .first('input_markings');
        const unionOutput = Array.isArray(pipeMarkings?.input_markings)
          ? (pipeMarkings!.input_markings as string[])
          : [];
        if (unionOutput.length > 0 && datasetId) {
          await this.knex('foundry_datasets')
            .where({ id: datasetId })
            .update({ markings: unionOutput });
        }

        // PB-B8 — lineage edges + Funnel auto-fire.
        //
        // 1. Insert (output_dataset → input_dataset, 'pipeline_output')
        //    edges for every input dataset this deploy read. We resolve
        //    inputs from pipeline_nodes.dataset_id; transform nodes with
        //    no dataset_id don't contribute.
        // 2. Walk dataset_lineage.findObjectTypesFor(output) for every
        //    OT whose backing_datasource matches the new output; send a
        //    Funnel `sourceTransactionCommitted` signal with
        //    fingerprint=`${deploymentId}-${ontology}-${ot}` so double-
        //    deploy is idempotent at the Funnel boundary.
        try {
          await this.applyDeployLineageAndSignals({
            pipelineId,
            deploymentId,
            outputDatasetId: datasetId,
            sourceTransactionId: rowCountExact
              ? String(rowCountExact)
              : deploymentId,
          });
        } catch (err) {
          // Lineage/signal emission is best-effort — a Funnel outage
          // must not fail the user's deploy. We log so the operator
          // can reconcile later.
          console.warn(
            `[deploy] lineage/auto-fire failed: ${(err as Error).message}`,
          );
        }

        // PB-B10 — fingerprint + schemaChanged fan-out. We compute the
        // diff against foundry_datasets.last_output_schema_fingerprint,
        // update the fingerprint column, and if the schema ACTUALLY
        // changed (and was safe — unsafe diffs were already rejected
        // in startDeployment) we fire a Funnel schemaChanged signal per
        // Object Type whose backing dataset is this output. The Funnel's
        // existing B9 replacement pipeline picks it up from there.
        try {
          await this.applySchemaEvolutionPostDeploy({
            pipelineId,
            deploymentId,
            outputDatasetId: datasetId,
            currentColumns: data.columns.map((c) => ({
              name: c.name,
              type: c.type ?? 'string',
            })),
          });
        } catch (err) {
          console.warn(
            `[deploy] schema evolution post-deploy failed: ${(err as Error).message}`,
          );
        }

        // Final defence: if we staged a Parquet file but failed to upload
        // and somehow the thrown error got swallowed, clean the tmp dir.
        if (parquetStagedPath) discardStagedParquet(parquetStagedPath);

        buildResults.push({
          nodeId: outputNode.id,
          nodeLabel: outputNode.label,
          datasetId,
          datasetName: outputNode.label,
          filePath: s3Key,
          rowCount: rowCountExact ?? data.rows.length,
          columnCount: data.columns.length,
          status: 'succeeded',
          durationMs: Date.now() - buildStart,
        });

        // Update deployment record with partial progress
        await this.knex('pipeline_deployments')
          .where({ id: deploymentId })
          .update({ build_results: JSON.stringify(buildResults) });

      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        buildResults.push({
          nodeId: outputNode.id,
          nodeLabel: outputNode.label,
          datasetId: '',
          datasetName: outputNode.label,
          filePath: '',
          rowCount: 0,
          columnCount: 0,
          status: 'failed',
          error: errMsg,
          durationMs: Date.now() - buildStart,
        });

        // Update deployment record with partial progress (including failure)
        await this.knex('pipeline_deployments')
          .where({ id: deploymentId })
          .update({ build_results: JSON.stringify(buildResults) });
      }
    }

    // Finalize deployment — but honour a late cancellation arriving after
    // the last output wrote. Without this guard the loop would mark the
    // deploy succeeded even though the user DELETE'd it mid-flight.
    if (await this.isCancellationRequested(deploymentId)) {
      await this.finaliseCancelled(deploymentId, buildResults);
      decrementOnExit();
      return;
    }

    const durationMs = Date.now() - startedAt;
    const succeededCount = buildResults.filter((r) => r.status === 'succeeded').length;
    const overallStatus = succeededCount > 0 ? 'succeeded' : 'failed';

    await this.knex('pipeline_deployments')
      .where({ id: deploymentId })
      .update({
        status: overallStatus,
        finished_at: new Date().toISOString(),
        duration_ms: durationMs,
        build_results: JSON.stringify(buildResults),
        error_message: overallStatus === 'failed'
          ? buildResults.filter((r) => r.status === 'failed').map((r) => r.error).join('; ')
          : null,
      });

    // PB-B9 — deploy duration + total counter + input rows processed.
    recordDeployDuration(pipelineId, overallStatus as 'succeeded' | 'failed', durationMs / 1000);
    const totalRows = buildResults.reduce((s, r) => s + (r.rowCount ?? 0), 0);
    addInputRowsProcessed(totalRows);
    decrementOnExit();

    // Update pipeline status on full success
    const newPipelineStatus = succeededCount === outputNodes.length ? 'active' : pipeline.status;
    if (newPipelineStatus !== pipeline.status) {
      await this.knex('pipelines')
        .where({ id: pipeline.id })
        .update({ status: newPipelineStatus });
    }
  }

  /** Get a single deployment by ID (used for polling) */
  async getDeployment(
    projectId: string,
    pipelineId: string,
    deploymentId: string,
  ): Promise<unknown> {
    const deployment = await this.knex('pipeline_deployments')
      .where({ id: deploymentId, pipeline_id: pipelineId, project_id: projectId })
      .first();
    if (!deployment) throw new AppError('Deployment not found', 404, 'NOT_FOUND');
    // Parse JSONB fields
    if (typeof deployment.build_results === 'string') {
      deployment.build_results = JSON.parse(deployment.build_results);
    }
    if (typeof deployment.config === 'string') {
      deployment.config = JSON.parse(deployment.config);
    }
    return deployment;
  }

  /** List deployments for a pipeline, most recent first */
  async listDeployments(projectId: string, pipelineId: string): Promise<unknown[]> {
    const rows = await this.knex('pipeline_deployments')
      .where({ pipeline_id: pipelineId, project_id: projectId })
      .orderBy('started_at', 'desc')
      .limit(50);
    return rows.map((r: Record<string, unknown>) => ({
      ...r,
      build_results: typeof r.build_results === 'string' ? JSON.parse(r.build_results as string) : r.build_results,
      config: typeof r.config === 'string' ? JSON.parse(r.config as string) : r.config,
    }));
  }
}
