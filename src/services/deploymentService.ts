import { Knex } from 'knex';
import fs from 'fs';
import { randomUUID } from 'crypto';
import { uploadObject, getObjectStream } from './storageService';
import { TransformService } from './transformService';
import { assertFolderNameAvailable } from './datasets/folderNameGuard';
import { DatasetTransactionService } from './datasets/transactionService';
import { applyWriteMode, validateWriteModeConfig } from './pipelines/writeModes';
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
  selectedBatchEngine,
  batchEngineMinRows,
  parseIcebergLocation,
  type IcebergTarget,
  type EngineExecutionResult,
} from './pipelines/computeEngine';
import {
  getTrinoEngine,
  trinoConfigFromEnv,
  trinoCoordinatorConfigured,
} from './pipelines/trinoAdapter';
import {
  compileBatchJob,
  compileFusedJob,
  type BatchSourceTable,
  type CompiledBatchJob,
  type FusedJoinSpec,
} from './pipelines/trinoSqlCompiler';
import type { TransformStep } from './pipelines/duckdbTransformEngine';
import {
  recordDeployDuration,
  incActiveDeploys,
  addInputRowsProcessed,
} from './pipelines/metrics';

// CSV serialization (RFC 4180) lives in ./deploy/csvSerialization (extracted
// during the god-file breakup; behavior identical, unit-tested in isolation).
import { rowsToCsvBuffer } from './deploy/csvSerialization';
// Iceberg sidecar output reads (snapshots / time-travel scan) extracted to
// ./deploy/icebergOutputReads — same pipeline-load + format-gate semantics.
import {
  listPipelineOutputSnapshots,
  readPipelineOutputAsOf,
} from './deploy/icebergOutputReads';
// Batch-engine selection gate extracted to ./deploy/batchEngineSelection.
import { shouldAttemptEngineBuild } from './deploy/batchEngineSelection';
// Preview-snapshot pinning (PB-B6) extracted to ./deploy/previewPinning.
import { collectPreviewPinning } from './deploy/previewPinning';

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
  /**
   * Foundry — `?replay=true`. "Replaying on deploy will produce a
   * `SNAPSHOT` transaction on the output dataset": incremental pipelines
   * reprocess the entire input when logic changed and prior outputs are
   * outdated.
   * (building-pipelines/create-incremental-pipeline-pb)
   */
  replay?: boolean;
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

/**
 * Map a join NODE's canvas config to the compiler's FusedJoinSpec. Returns
 * null for a malformed/unsupported spec (missing join type, or a non-cross
 * join with no equi-keys) so the caller falls back to the in-process path.
 * Mirrors the field reads in transformService.materializeForDeploy's join case.
 */
 
function joinFusionSpecFromConfig(cfg: any): FusedJoinSpec | null {
  const joinType = cfg?.joinType as FusedJoinSpec['joinType'] | undefined;
  if (!joinType) return null;
  const conditions = Array.isArray(cfg.conditions) ? cfg.conditions : [];
  const on = conditions
     
    .filter((c: any) => c && c.leftColumn && c.rightColumn)
     
    .map((c: any) => ({ left: String(c.leftColumn), right: String(c.rightColumn) }));
  if (joinType !== 'cross' && on.length === 0) return null;
  return {
    kind: 'join',
    joinType,
    on,
    rightPrefix: typeof cfg.rightPrefix === 'string' ? cfg.rightPrefix : 'right_',
    allowCrossJoin: cfg.allowCrossJoin === true,
    leftSelected: Array.isArray(cfg.leftSelectedColumns)
      ? cfg.leftSelectedColumns.map(String)
      : undefined,
    rightSelected: Array.isArray(cfg.rightSelectedColumns)
      ? cfg.rightSelectedColumns.map(String)
      : undefined,
  };
}

export class DeploymentService {
  constructor(
    private knex: Knex,
    private transformService: TransformService,
  ) {}

  /**
   * Read the dataset's current view from the LATEST committed transaction
   * on `master` (Datasets v2: the transaction log is authoritative).
   * Returns [] when there is no committed build yet or the view is not
   * CSV (write modes only merge CSV views; other formats treat the
   * previous view as empty).
   */
  private async readLatestViewRows(
    datasetId: string,
  ): Promise<Array<Record<string, unknown>>> {
    const tx = await this.knex('foundry_dataset_transactions')
      .where({ dataset_id: datasetId, branch_name: 'master', status: 'committed' })
      .orderBy('committed_at', 'desc')
      .first('file_path');
    // No committed transaction yet — first build of this dataset.
    const filePath = (tx?.file_path as string | undefined) ??
      (await this.knex('foundry_datasets').where({ id: datasetId }).first('file_path'))
        ?.file_path;
    if (!filePath || !String(filePath).endsWith('.csv')) return [];
    const stream = await getObjectStream(String(filePath));
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    const text = Buffer.concat(chunks).toString('utf-8');
    const { parse } = await import('csv-parse/sync');
    return parse(text, { columns: true, skip_empty_lines: true, bom: true }) as Array<
      Record<string, unknown>
    >;
  }

  /**
   * Foundry default write mode precondition: APPEND iff at least one
   * input is incremental AND all incremental inputs saw only
   * APPEND/additive UPDATE transactions. Our input datasets are
   * file-upload/extract based, so `computation_mode='incremental'` on the
   * input node's config is the marker the rule keys on.
   */
  private async isIncrementalAppendEligible(pipelineId: string): Promise<boolean> {
    const inputs = await this.knex('pipeline_nodes')
      .where({ pipeline_id: pipelineId, node_type: 'dataset' })
      .select('config');
    if (inputs.length === 0) return false;
    let anyIncremental = false;
    for (const n of inputs) {
      const cfg = typeof n.config === 'string' ? JSON.parse(n.config) : (n.config ?? {});
      if (cfg.computationMode !== 'incremental') return false;
      anyIncremental = true;
    }
    return anyIncremental;
  }

  /**
   * Foundry Datasets v2 storage model — every successful build commits a
   * transaction on the output dataset's branch (default `master`). The
   * dataset row's latest view is written from the same payload, so the
   * current view always equals the last committed transaction.
   */
  private async recordOutputTransaction(args: {
    datasetId: string;
    deploymentId: string;
    pipelineId: string;
    outputNodeId: string;
    filePath: string;
    fileSizeBytes?: number | null;
    rowCount?: number | null;
    columnCount?: number | null;
    createdBy?: string | null;
    transactionType?: 'SNAPSHOT' | 'APPEND' | 'UPDATE';
    writeMode?: string;
    /** Replay on deploy — always commits SNAPSHOT (Foundry doc). */
    replay?: boolean;
  }): Promise<void> {
    await new DatasetTransactionService(this.knex).recordBuild({
      datasetId: args.datasetId,
      branch: 'master',
      transactionType: args.replay ? 'SNAPSHOT' : (args.transactionType ?? 'SNAPSHOT'),
      deploymentId: args.deploymentId,
      filePath: args.filePath,
      fileSizeBytes: args.fileSizeBytes ?? null,
      rowCount: args.rowCount ?? null,
      columnCount: args.columnCount ?? null,
      createdBy: args.createdBy ?? null,
      metadata: {
        pipelineId: args.pipelineId,
        outputNodeId: args.outputNodeId,
        writeMode: args.writeMode ?? 'default',
        replayOnDeploy: args.replay === true || undefined,
      },
    });
  }

  // ============================================================================
  // Output dataset name validation
  // ============================================================================
  //
  // The deploy writes bytes to S3 BEFORE it touches `foundry_datasets`. If the
  // dataset row write later fails because of a constraint violation, those
  // bytes orphan in object storage and the user sees `deploy failed` with the
  // deploy log pointing at a Postgres error that has no bearing on what they
  // edited. To make rename-driven failures fail-fast with an actionable error,
  // validate the canvas label at the deploy boundary BEFORE materialization.
  //
  // Rules (kept in lock-step with the `foundry_datasets.name` column):
  //   - non-empty after trim
  //   - ≤ 255 chars (the varchar(255) column width)
  //   - no NUL bytes or control chars (these tend to come from copy-paste from
  //     terminal output and silently corrupt the file listing)
  //
  // Collision (same name in same folder) is intentionally NOT enforced here —
  // datasetService.updateDataset has its own ConflictError flow, and the
  // existing-dataset UPDATE in this file is keyed on the immutable
  // `outputDatasetId`, not on (folder_id, name). A collision policy can be
  // layered on later without changing this signature.
  //
  // Exported as a static so the canvas's Apply/save flow on the output node
  // can call the same function before persisting the new label — a single
  // source of truth for "is this a deploy-safe name?".
  static readonly OUTPUT_DATASET_NAME_MAX = 255;
  static validateOutputDatasetName(label: unknown): void {
    if (typeof label !== 'string') {
      throw new AppError(
        'Output node label must be a string.',
        400,
        'OUTPUT_NAME_INVALID',
      );
    }
    const trimmed = label.trim();
    if (trimmed.length === 0) {
      throw new AppError(
        'Output node label cannot be empty. Open the output node and give it a name.',
        400,
        'OUTPUT_NAME_EMPTY',
      );
    }
    if (label.length > DeploymentService.OUTPUT_DATASET_NAME_MAX) {
      throw new AppError(
        `Output node label is ${label.length} characters; the maximum is ` +
          `${DeploymentService.OUTPUT_DATASET_NAME_MAX}. Shorten the name on the canvas before deploying.`,
        400,
        'OUTPUT_NAME_TOO_LONG',
      );
    }
    // U+0000 + C0 controls + U+007F + C1 controls. Newlines and tabs are
    // included because a name that wraps a file-tree row is almost never
    // intentional and is a footgun for downstream consumers (CSV exports,
    // shell scripts, S3 keys).
    if (/[\u0000-\u001F\u007F-\u009F]/.test(label)) {
      throw new AppError(
        'Output node label contains control characters. Use printable characters only.',
        400,
        'OUTPUT_NAME_CONTROL_CHARS',
      );
    }
  }

  // ============================================================================
  // Output dataset placement
  // ============================================================================
  //
  // Foundry parity: "After the first build of your pipeline, your dataset
  // output will be created in the same folder as your pipeline."
  // (pipeline-builder/outputs-add-dataset-output). Pipeline Builder offers no
  // free-text path field for an output — placement is inherited, not authored.
  //
  // Before this, both `foundry_datasets` INSERT sites set `project_id` and left
  // `folder_id` NULL, and `datasetService.listProjectRootDatasets` treats
  // `folder_id IS NULL` as "project root" — so every deployed output surfaced
  // at the root no matter which folder its pipeline lived in.
  //
  // Only the INSERT sites call this. The existing-dataset UPDATE branches are
  // deliberately left alone: they are keyed on the immutable `outputDatasetId`,
  // so once a dataset exists the user may move it in the file tree and a
  // redeploy must not drag it back to the pipeline's folder.
  //
  // Returns null (→ project root, the previous behaviour) when the pipeline sits
  // at the root itself, or when its folder is missing or belongs to another
  // project. That last check matters because `folder_id` FKs to `folders`, whose
  // own `project_id` is the authority for the file tree — inheriting a foreign
  // project's folder would make the output vanish from this project's listing
  // while still resolving the FK.
  private async resolveOutputFolderId(
    pipelineId: string,
    projectId: string,
  ): Promise<string | null> {
    const pipeline = await this.knex('pipelines')
      .where({ id: pipelineId })
      .first('folder_id');
    const folderId = pipeline?.folder_id as string | null | undefined;
    if (!folderId) return null;
    const folder = await this.knex('folders')
      .where({ id: folderId, project_id: projectId })
      .first('id');
    if (!folder) {
      console.warn(
        `[deploy] pipeline ${pipelineId} references folder ${folderId} which is ` +
          `not in project ${projectId}; placing output at the project root`,
      );
      return null;
    }
    return folderId;
  }

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
      // Foundry replay-on-deploy marker — executeBuild forces SNAPSHOT.
      replay: opts.replay === true || undefined,
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
          // FUNN-ISO: deployment-scoped namespace + queue.
          const { getEnvironmentIdentity } = await import("../config/environmentIdentity");
          const identity = getEnvironmentIdentity();
          const conn = await Connection.connect({ address: identity.temporalAddress });
          const client = new Client({
            connection: conn,
            namespace: identity.temporalNamespace,
            identity: identity.workerIdentity,
          });
          const taskQueue = identity.temporalTaskQueue;
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

  /**
   * Resolve a streaming pipeline's dataset source nodes into FlinkDatasetNodes.
   * A dataset with `format='stream'` becomes a Kafka source (`kind:'stream'`,
   * `source`=topic from `file_path`, bootstrap servers from the env); every
   * other format is a `batch` source (Iceberg/Parquet/CSV). Shared by the
   * initial deploy and restart so the topology (esp. the Kafka topic) is never
   * lost on restart.
   */
  private async resolveStreamingSources(
    pipelineId: string,
  ): Promise<FlinkDatasetNode[]> {
    const datasetNodes = await this.knex('pipeline_nodes as pn')
      .leftJoin('foundry_datasets as fd', 'pn.dataset_id', 'fd.id')
      .where({ 'pn.pipeline_id': pipelineId, 'pn.node_type': 'dataset' })
      .select(
        'pn.id as id',
        'pn.label as label',
        'fd.file_path as file_path',
        'fd.format as format',
      );

    return Promise.all(
      datasetNodes.map(
        async (
          n: { id: string; label: string; file_path?: string | null; format?: string | null },
          i: number,
        ): Promise<FlinkDatasetNode> => {
          const cols = n.file_path
            ? await this.knex('dataset_columns as dc')
                .join('pipeline_nodes as pn', 'pn.dataset_id', 'dc.dataset_id')
                .where({ 'pn.id': n.id })
                .select('dc.column_name as name', 'dc.column_type as type')
                .orderBy('dc.ordinal_position', 'asc')
            : [];
          const isStream = n.format === 'stream';
          return {
            id: n.id,
            label: n.label ?? `src_${i}`,
            kind: isStream ? 'stream' : 'batch',
            source: n.file_path ?? '',
            columns: cols.map((c: { name: string; type: string }) => ({
              name: c.name,
              type: c.type,
            })),
            // Kafka sources read JSON by default and inherit the deployment's
            // broker address from the env (per-source override is future work).
            ...(isStream
              ? {
                  format: 'json',
                  bootstrapServers: process.env.KAFKA_BOOTSTRAP_SERVERS,
                }
              : {}),
          };
        },
      ),
    );
  }

  private async executeStreamingBuild(
    projectId: string,
    pipelineId: string,
    deploymentId: string,
     
    outputNodes: any[],
     
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

    // 2. Gather source dataset nodes + their columns via the shared resolver
    //    (also used by restartStreamingDeploy so a restart never loses the
    //    Kafka topic / source metadata).
    const sources = await this.resolveStreamingSources(pipelineId);

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
    const outNodes = await this.knex('pipeline_nodes')
      .where({ pipeline_id: pipelineId, node_type: 'output' });
    const out = outNodes[0];
    if (!out) throw new AppError('No output node on pipeline.', 400, 'NO_OUTPUTS');
    const outCfg = typeof out.config === 'string' ? JSON.parse(out.config) : (out.config ?? {});
    const transforms = Array.isArray(outCfg.transforms) ? outCfg.transforms : [];
    const outputSchema = Array.isArray(outCfg.columns)
      ? outCfg.columns.map((c: { name: string; type: string }) => ({ name: c.name, type: c.type }))
      : [];

    // Resolve sources via the shared resolver — preserves the real Kafka
    // topic / columns / format across restart (the old code hardcoded empty
    // stream sources, which compiled to an invalid job).
    const sources = await this.resolveStreamingSources(pipelineId);

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
    return listPipelineOutputSnapshots(this.knex, projectId, pipelineId);
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
    return readPipelineOutputAsOf(this.knex, projectId, pipelineId, opts);
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
   * PB-B6 preview-snapshot pinning. Implementation lives in
   * ./deploy/previewPinning (extracted during the god-file breakup;
   * behavior identical, unit-tested in isolation).
   */
  private async collectPreviewPinning(
    _pipelineId: string,
    nodes: any[],
    flags: { force: boolean; ignorePreviewSnapshot: boolean },
  ): Promise<{
    inputSnapshots: Record<string, unknown>;
    chainHashDigest: string | null;
    divergenceWarning: boolean;
    staleNodeIds: string[];
  }> {
    return collectPreviewPinning(_pipelineId, nodes, flags);
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

    // 0. Point every foundry-bridged backing_datasource at the file this
    // deployment just published. The bridged file_path is synthetic:
    // `<s3-key>#foundry-dataset:<uuid>#object-type:<uuid>` — the pre-tag
    // prefix is what reindex/merge actually READ, while the tags are the
    // stable identity. Without this refresh the prefix keeps pointing at
    // the file that existed when the binding was registered, so builds
    // commit new data while the Ontology keeps materialising the old file
    // — the pipeline looks healthy while Ontology objects stay stale.
    try {
      const current = await this.knex('foundry_datasets')
        .where({ id: input.outputDatasetId })
        .first('file_path');
      if (current?.file_path) {
        await this.knex('backing_datasource')
          .where({ foundry_dataset_id: input.outputDatasetId })
          .whereRaw("file_path LIKE '%#foundry-dataset:%'")
          .update({
            // Keep everything from the first tag onward (identity) and
            // swap only the S3-key prefix (content pointer).
            file_path: this.knex.raw(
              "? || substr(file_path, strpos(file_path, '#foundry-dataset:'))",
              [current.file_path],
            ),
          });
      }
    } catch (err) {
      // Best-effort: a refresh failure must not fail the deployment; the
      // signals below still fire and the binding can be repaired.
      console.warn(
        `[deploy] backing_datasource file_path refresh skipped: ${(err as Error).message}`,
      );
    }

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
    // this output dataset, fire exactly one reindexing signal with a
    // deduping fingerprint.
    //
    // Do not also enqueue `pipelineDeployCompleted` here. The Funnel
    // dispatcher treats every signal as an indexing run, while the Temporal
    // workflow intentionally has no handler for that notification-only
    // signal. Emitting both therefore creates a second run which can remain
    // `workflow_started` and overwrite the successful run's UI projection
    // with a permanent `indexing` state. Pipeline completion notifications
    // need a separate event/outbox consumer; they must not share the Object
    // Type reindex queue.
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
          // Dynamic import so this hot path stays out of the deploy
          // service's cold start cost when the chain has no pinned
          // S3 inputs. Hoisted out of the Promise executor because that
          // executor is a sync callback — `await` is not legal there.
          const { sanitizeCsvHeader } = await import('../utils/csvHeader');
          const rows = await new Promise<Array<Record<string, string>>>(
            (resolve, reject) => {
              const acc: Array<Record<string, string>> = [];
              const parser = parse({
                delimiter: node.file_path.endsWith('.tsv') ? '\t' : ',',
                // See `src/utils/csvHeader.ts` — prevents silent column
                // drop when the pinned-version CSV has duplicate or blank
                // header cells. Matches the sanitizer used at preview
                // time so deploy reads the same schema.
                columns: (h: string[]) =>
                  sanitizeCsvHeader(h, { source: node.file_path }),
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
      const { sanitizeCsvHeader } = await import('../utils/csvHeader');
      const rows = await new Promise<Array<Record<string, string>>>(
        (resolve, reject) => {
          const acc: Array<Record<string, string>> = [];
          const parser = parse({
            delimiter: entry.file_path.endsWith('.tsv') ? '\t' : ',',
            // See `src/utils/csvHeader.ts` — prevents silent column drop
            // when the pinned transitive-input CSV has duplicate or blank
            // header cells.
            columns: (h: string[]) =>
              sanitizeCsvHeader(h, { source: entry.file_path }),
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
   * FOUNDRY-GAPS §1 — engine-eligible build path (strangler-fig branch).
   *
   * Compiles a LINEAR output chain (dataset → transform* → output) whose
   * source dataset already lives in Iceberg to a Trino SQL plan and
   * dispatches it through the ComputeEngine contract. The engine writes the
   * sink table directly via the Lakekeeper REST catalog, so:
   *   - rows never materialize in the Node heap (the scaling wall at
   *     transformService.materializeForDeploy);
   *   - the snapshot commit gets catalog OCC for free (no manual retry);
   *   - the PyIceberg write-sidecar is bypassed;
   *   - reads are pinned to the input's recorded snapshot (time travel)
   *     for reproducible builds.
   *
   * Returns null on ANY ineligibility or failure — the caller then runs the
   * legacy in-process path unchanged. Eligibility: TELLUS_BATCH_ENGINE=trino,
   * output_format=iceberg, linear chain (join/union NODES stay in-process in
   * v1), Iceberg-format source dataset, and input rows ≥
   * TELLUS_BATCH_ENGINE_MIN_ROWS.
   */
  private async tryEngineBuild(args: {
    projectId: string;
    pipelineId: string;
    deploymentId: string;
     
    outputNode: any;
     
    cfg: any;
     
    pipeline: any;
    triggeredBy: string;
  }): Promise<{
    datasetId: string;
    filePath: string;
    rowCount: number;
    columnCount: number;
  } | null> {
    // Engine-selection gate extracted to ./deploy/batchEngineSelection
    // (pure predicate; env reads stay here at the call site).
    if (
      !shouldAttemptEngineBuild({
        engineMode: selectedBatchEngine(),
        coordinatorConfigured: trinoCoordinatorConfigured(),
        outputFormat: args.pipeline.output_format,
      })
    ) {
      return null;
    }

    try {
      // 1. Peek the output's source node to choose the plan shape.
      const outputSrcId = args.cfg.sourceNodeId as string | undefined;
      if (!outputSrcId) return null;
      const srcNode = await this.knex('pipeline_nodes')
        .where({ id: outputSrcId, pipeline_id: args.pipelineId })
        .select('id', 'node_type', 'config')
        .first();
      if (!srcNode) return null;
      const catalog = trinoConfigFromEnv().catalog;

      // 2a. FUSION: the output's source is a join/union NODE. Resolve BOTH
      // arms to Iceberg tables and compile a multi-input Trino plan — this is
      // what retires the in-process executeJoin/union arrays for large data.
      if (srcNode.node_type === 'join' || srcNode.node_type === 'union') {
        const nCfg =
          typeof srcNode.config === 'string'
            ? JSON.parse(srcNode.config)
            : (srcNode.config ?? {});
        const leftArm = await this.resolveIcebergArm(
          args.pipelineId,
          nCfg.sourceNodeId as string | undefined,
        );
        const rightArm = await this.resolveIcebergArm(
          args.pipelineId,
          nCfg.rightNodeId as string | undefined,
        );
        if (!leftArm || !rightArm) return null;
        // Strangler threshold: fuse only when either arm is large enough to
        // matter (small joins are cheap in-process and avoid engine latency).
        if (Math.max(leftArm.rowEstimate, rightArm.rowEstimate) < batchEngineMinRows()) {
          return null;
        }
        const fusion: FusedJoinSpec | { kind: 'union' } | null =
          srcNode.node_type === 'join'
            ? joinFusionSpecFromConfig(nCfg)
            : { kind: 'union' };
        if (!fusion) return null;

        const engine = getTrinoEngine();
        if (!(await engine.available())) {
          console.warn(
            '[deploy] engine path selected but Trino coordinator unavailable — falling back to in-process build.',
          );
          return null;
        }
        const target = await this.buildEngineTarget(args);
        const plan = compileFusedJob({
          catalog,
          left: leftArm,
          right: rightArm,
          fusion,
          output: target,
        });
        const result = await engine.executePlan(plan, target);
        return await this.recordEngineBuild({ args, plan, result, target });
      }

      // 2b. LINEAR: a transform chain over a single Iceberg table.
      const arm = await this.resolveIcebergArm(args.pipelineId, outputSrcId);
      if (!arm) return null;
      if (arm.rowEstimate < batchEngineMinRows()) return null;

      const engine = getTrinoEngine();
      if (!(await engine.available())) {
        console.warn(
          '[deploy] engine path selected but Trino coordinator unavailable — falling back to in-process build.',
        );
        return null;
      }
      const target = await this.buildEngineTarget(args);
      const plan = compileBatchJob({
        catalog,
        inputs: [arm.source],
        transforms: arm.transforms,
        output: target,
      });
      const result = await engine.executePlan(plan, target);
      return await this.recordEngineBuild({ args, plan, result, target });
    } catch (err) {
      // Strangler-fig safety: engine problems NEVER fail the deploy — the
      // in-process path is the fallback of record.
      console.warn(
        `[deploy] engine build fell back to in-process: ${(err as Error).message}`,
      );
      return null;
    }
  }

  /**
   * Resolve a single pipeline arm — a linear transform chain rooted at one
   * Iceberg dataset — to a Trino source table + folded transforms. Returns
   * null on any non-linear node (nested join/union), a Join/Union transform
   * STEP (needs multi-input planning), a non-Iceberg leaf, or missing columns,
   * so the caller falls back to the in-process path. Shared by the linear and
   * fused (join/union node) engine builds.
   */
  private async resolveIcebergArm(
    pipelineId: string,
    startNodeId: string | undefined,
  ): Promise<{
    source: BatchSourceTable;
    transforms: TransformStep[];
    rowEstimate: number;
  } | null> {
    if (!startNodeId) return null;
    const transforms: TransformStep[] = [];
    let cursor: string | undefined = startNodeId;
    const seen = new Set<string>();
     
    let datasetNode: any = null;
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      const n = await this.knex('pipeline_nodes')
        .where({ id: cursor, pipeline_id: pipelineId })
        .select('id', 'node_type', 'dataset_id', 'config')
        .first();
      if (!n) return null;
      const nCfg =
        typeof n.config === 'string' ? JSON.parse(n.config) : (n.config ?? {});
      const own: TransformStep[] = Array.isArray(nCfg.transforms)
        ? nCfg.transforms
        : [];
      // An arm folds linear ops only; a Join/Union STEP would need a second
      // registered input — out of scope for a single arm.
      if (own.some((t) => t.function === 'Join' || t.function === 'Union')) {
        return null;
      }
      transforms.unshift(...own);
      if (n.node_type === 'dataset') {
        datasetNode = n;
        break;
      }
      // A nested join/union NODE inside an arm needs recursive fusion — not
      // supported yet; fall back to in-process for that pipeline.
      if (n.node_type !== 'transform') return null;
      cursor = nCfg.sourceNodeId as string | undefined;
    }
    if (!datasetNode?.dataset_id) return null;

    const ds = await this.knex('foundry_datasets')
      .where({ id: datasetNode.dataset_id })
      .first();
    if (!ds || ds.format !== 'iceberg' || !ds.file_path) return null;
    const loc = parseIcebergLocation(String(ds.file_path));
    if (!loc) return null;

    const srcCols = await this.knex('dataset_columns')
      .where({ dataset_id: ds.id })
      .orderBy('ordinal_position', 'asc')
      .select('column_name', 'column_type');
    if (srcCols.length === 0) return null;

    return {
      source: {
        id: datasetNode.id,
        label: ds.name ?? 'input',
        namespace: loc.namespace,
        table: loc.table,
        snapshotId: loc.snapshotId,
        columns: srcCols.map(
          (c: { column_name: string; column_type: string }) => ({
            name: c.column_name,
            type: c.column_type ?? 'string',
          }),
        ),
      },
      transforms,
      rowEstimate: Number(ds.row_count_exact ?? ds.row_count ?? 0),
    };
  }

  /**
   * Resolve the pipeline's Iceberg sink target (warehouse/namespace/leaf),
   * ensuring the namespace exists. Shared by the linear and fused builds so
   * downstream readers see one location format regardless of plan shape.
   */
  private async buildEngineTarget(args: {
    projectId: string;
    pipelineId: string;
     
    pipeline: any;
  }): Promise<IcebergTarget> {
    const projectSlug = slugForNamespace(
      `proj_${args.projectId.replace(/-/g, '').slice(0, 12)}`,
    );
    const pipelineSlug = slugForNamespace(
      `${(args.pipeline.name ?? 'pipe').toString()}_${args.pipelineId.replace(/-/g, '').slice(0, 8)}`,
    );
    const { ensurePipelineNamespace, pipelineWarehouseName } = await import(
      './pipelines/lakekeeperBootstrap'
    );
    const warehouse = pipelineWarehouseName();
    const namespace = await ensurePipelineNamespace(projectSlug, pipelineSlug);
    return {
      warehouse,
      namespace,
      table: PIPELINE_LEAF_TABLE,
      catalogUri: process.env.LAKEKEEPER_URL ?? 'http://localhost:8181',
    };
  }

  /**
   * Persist the engine build's output — mirrors the sidecar path's dataset /
   * column / lineage / marking records so the rest of the platform (Funnel,
   * lineage graph, FE) can't tell which engine wrote. Shared by linear + fused
   * builds (they differ only in how `plan` was compiled).
   */
  private async recordEngineBuild(p: {
    args: {
      projectId: string;
      pipelineId: string;
      deploymentId: string;
       
      outputNode: any;
       
      cfg: any;
      triggeredBy: string;
    };
    plan: CompiledBatchJob;
    result: EngineExecutionResult;
    target: IcebergTarget;
  }): Promise<{
    datasetId: string;
    filePath: string;
    rowCount: number;
    columnCount: number;
  }> {
    const { args, plan, result, target } = p;
    const filePath = `${target.warehouse}/${target.namespace}/${target.table}`;
    await this.knex('pipeline_deployments')
      .where({ id: args.deploymentId })
      .update({
        output_table_location: `${target.warehouse}:${target.namespace}.${target.table}`,
      });

    let datasetId: string;
    const existingDatasetId = args.cfg.outputDatasetId as string | undefined;
    const datasetPatch = {
      name: args.outputNode.label,
      file_path: filePath,
      row_count: result.rowCount,
      row_count_exact: result.rowCount,
      column_count: plan.outputSchema.length,
      file_size_bytes: 0,
      mime_type: 'application/vnd.apache.iceberg',
      format: 'iceberg',
      original_filename: `${args.outputNode.label
        .replace(/[^a-zA-Z0-9_-]/g, '_')
        .toLowerCase()}.iceberg`,
      status: 'ready',
      updated_by: args.triggeredBy,
    };
    if (existingDatasetId) {
      // Foundry parity — ResourceNameAlreadyExists (409): the rename that
      // keeps the dataset name in lock-step with the output-node label
      // must not collide with a sibling resource in the same folder.
      const current = (await this.knex('foundry_datasets')
        .where({ id: existingDatasetId })
        .first('name', 'folder_id', 'project_id')) as
        | { name: string; folder_id: string | null; project_id: string | null }
        | undefined;
      if (current && current.name !== datasetPatch.name) {
        await assertFolderNameAvailable(this.knex, {
          name: datasetPatch.name,
          folderId: current.folder_id ?? null,
          projectId: current.project_id ?? args.projectId,
          excludeDatasetId: existingDatasetId,
        });
      }
      await this.knex('foundry_datasets')
        .where({ id: existingDatasetId })
        .update(datasetPatch);
      datasetId = existingDatasetId;
      await this.knex('dataset_columns').where({ dataset_id: datasetId }).del();
    } else {
      // Foundry parity — a new output lands in the pipeline's own folder,
      // and its name must be unique among that folder's resources.
      const outputFolderId = await this.resolveOutputFolderId(
        args.pipelineId,
        args.projectId,
      );
      await assertFolderNameAvailable(this.knex, {
        name: datasetPatch.name,
        folderId: outputFolderId,
        projectId: args.projectId,
      });
      const [newDataset] = await this.knex('foundry_datasets')
        .insert({
          ...datasetPatch,
          project_id: args.projectId,
          folder_id: outputFolderId,
          created_by: args.triggeredBy,
        })
        .returning('*');
      datasetId = newDataset.id;
      await this.knex('pipeline_nodes')
        .where({ id: args.outputNode.id })
        .update({
          dataset_id: datasetId,
          config: JSON.stringify({ ...args.cfg, outputDatasetId: datasetId }),
        });
    }
    await this.knex('dataset_columns').insert(
      plan.outputSchema.map((col, idx) => ({
        dataset_id: datasetId,
        column_name: col.name,
        column_type: col.type || 'string',
        ordinal_position: idx + 1,
        nullable: true,
        logical_type: pipelineTypeToParquetLogicalType(col.type ?? 'string'),
      })),
    );

    const pipeMarkings = await this.knex('pipelines')
      .where({ id: args.pipelineId })
      .first('input_markings');
    const unionOutput = Array.isArray(pipeMarkings?.input_markings)
      ? (pipeMarkings!.input_markings as string[])
      : [];
    if (unionOutput.length > 0) {
      await this.knex('foundry_datasets')
        .where({ id: datasetId })
        .update({ markings: unionOutput });
    }
    await this.recordOutputTransaction({
      datasetId,
      deploymentId: args.deploymentId,
      pipelineId: args.pipelineId,
      outputNodeId: args.outputNode.id,
      filePath,
      fileSizeBytes: 0,
      rowCount: result.rowCount,
      columnCount: plan.outputSchema.length,
      createdBy: args.triggeredBy,
    });
    try {
      await this.applyDeployLineageAndSignals({
        pipelineId: args.pipelineId,
        deploymentId: args.deploymentId,
        outputDatasetId: datasetId,
        sourceTransactionId: String(result.rowCount || args.deploymentId),
      });
    } catch (err) {
      console.warn(
        `[deploy] lineage/auto-fire failed (engine path): ${(err as Error).message}`,
      );
    }
    try {
      await this.applySchemaEvolutionPostDeploy({
        pipelineId: args.pipelineId,
        deploymentId: args.deploymentId,
        outputDatasetId: datasetId,
        currentColumns: plan.outputSchema,
      });
    } catch (err) {
      console.warn(
        `[deploy] schema evolution post-deploy failed (engine path): ${(err as Error).message}`,
      );
    }

    console.log(
      `[deploy] output "${args.outputNode.label}" built by ${result.engine}: ` +
        `${result.rowCount} rows in ${result.elapsedMs}ms (queries: ${result.queryIds.join(', ')})`,
    );
    return {
      datasetId,
      filePath,
      rowCount: result.rowCount,
      columnCount: plan.outputSchema.length,
    };
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
     
    outputNodes: any[],
     
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
        // ── Output-name boundary validation ──────────────────────
        // We MUST validate the display name before the S3 upload —
        // otherwise an over-length or empty label would orphan bytes
        // in object storage (PUT succeeds, foundry_datasets UPDATE
        // fails with `value too long for type character varying(255)`
        // and the deploy marks failed). Fail fast, before any side
        // effects, with a typed error the FE can render.
        DeploymentService.validateOutputDatasetName(outputNode.label);

        // ── FOUNDRY-GAPS §1 — engine branch (strangler-fig) ───────
        // When TELLUS_BATCH_ENGINE=trino and this output's chain is
        // engine-eligible (linear DAG, Iceberg input above the row
        // threshold), compile the pipeline_nodes DAG to Trino SQL and
        // dispatch — rows never transit the Node heap; the engine's
        // Iceberg connector commits the snapshot via the Lakekeeper
        // REST catalog (catalog OCC, no manual retry, no PyIceberg
        // sidecar). Any ineligibility or engine failure returns null
        // and the legacy in-process path below runs unchanged.
        const engineBuild = await this.tryEngineBuild({
          projectId,
          pipelineId,
          deploymentId,
          outputNode,
          cfg,
          pipeline,
          triggeredBy,
        });
        if (engineBuild) {
          buildResults.push({
            nodeId: outputNode.id,
            nodeLabel: outputNode.label,
            datasetId: engineBuild.datasetId,
            datasetName: outputNode.label,
            filePath: engineBuild.filePath,
            rowCount: engineBuild.rowCount,
            columnCount: engineBuild.columnCount,
            status: 'succeeded',
            durationMs: Date.now() - buildStart,
          });
          await this.knex('pipeline_deployments')
            .where({ id: deploymentId })
            .update({ build_results: JSON.stringify(buildResults) });
          continue;
        }

        // Resolve upstream data
        let data: { columns: Array<{ name: string; type: string }>; rows: Array<Record<string, unknown>>; totalRows: number };
        try {
          // PB-deploy-fix — full DAG re-execution, unbounded. The legacy
          // outputPreview path resolved each output via resolveNodeData →
          // previewSnapshot.rows, and join/union nodes HARD-REQUIRE the
          // snapshot (they can't be linearly composed). The canvas persists
          // those snapshots capped at ~500 rows for instant feedback, so
          // any pipeline whose terminal output passed through a join or
          // union silently dropped every row past 500 — independent of
          // the 100k cap on the outputPreview slice itself. The deploy
          // path now re-reads every CSV unbounded and re-executes every
          // transform / join / union from raw inputs (Foundry semantics:
          // preview is bounded; deploy is unbounded).
          data = await this.transformService.materializeForDeploy(
            projectId, pipelineId, outputNode.id,
          );
        } catch (resolveErr) {
          const msg = resolveErr instanceof Error ? resolveErr.message : String(resolveErr);
          const code = (resolveErr as { code?: string })?.code;
          if (
            code === 'SNAPSHOT_REQUIRED' ||
            msg.includes('SNAPSHOT_REQUIRED') ||
            msg.includes('no preview snapshot has been captured')
          ) {
            throw new Error(
              `Cannot build "${outputNode.label}": an upstream join/union node has ` +
                `no preview snapshot. Open the node and click "Apply" before deploying. ` +
                `Deploys must replay the snapshot — they cannot re-execute joins/unions ` +
                `from the linear transform chain (would silently drop one branch).`,
            );
          }
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

        // ── Defense-in-depth: deploy-output schema invariant ──────
        // If the output node's immediate upstream is a join or union,
        // its previewSnapshot.columns IS the contractual output schema.
        // Hard-fail when what we're about to write disagrees — this
        // catches any future resolveNodeData regression at the LAST
        // possible point before bytes hit S3.
        try {
          const cfgForInvariant =
            typeof outputNode.config === 'string'
              ? JSON.parse(outputNode.config)
              : (outputNode.config ?? {});
          const srcId = (cfgForInvariant?.sourceNodeId ?? null) as string | null;
          if (srcId) {
            const upstream = await this.knex('pipeline_nodes')
              .where({ id: srcId, pipeline_id: pipelineId })
              .select('node_type', 'config')
              .first();
            const isAggregating =
              upstream?.node_type === 'join' || upstream?.node_type === 'union';
            if (isAggregating) {
              const upCfg =
                typeof upstream.config === 'string'
                  ? JSON.parse(upstream.config)
                  : (upstream.config ?? {});
              const expected: Array<{ name: string; type: string }> =
                upCfg?.previewSnapshot?.columns ?? [];
              if (expected.length > 0 && expected.length !== data.columns.length) {
                const expectedNames = expected.map((c) => c.name);
                const actualNames = data.columns.map((c) => c.name);
                const missing = expectedNames.filter((n) => !actualNames.includes(n));
                const extra = actualNames.filter((n) => !expectedNames.includes(n));
                throw new AppError(
                  `Deploy schema invariant violated for "${outputNode.label}": ` +
                    `upstream ${upstream.node_type} (${srcId}) snapshot has ` +
                    `${expected.length} columns but resolved data has ` +
                    `${data.columns.length}. ` +
                    (missing.length ? `Missing: ${missing.join(', ')}. ` : '') +
                    (extra.length ? `Extra: ${extra.join(', ')}. ` : '') +
                    `Refusing to write a corrupted dataset.`,
                  500,
                  'DEPLOY_SCHEMA_DRIFT',
                );
              }
            }
          }
        } catch (invariantErr) {
          if (invariantErr instanceof AppError) throw invariantErr;
          // Non-fatal invariant lookup failure — log and proceed; the
          // primary correctness gate is resolveNodeData itself.
          console.warn(
            `[deploy] schema invariant check failed (non-fatal): ` +
              `${(invariantErr as Error).message}`,
          );
        }

        // ── Foundry parity — required-column mapping is deploy-GATING ──
        // "You will not be able to deploy your pipeline until the 2
        //  missing columns are mapped."
        // The output node's config declares the mapped schema
        // (`expectedColumns`, one entry per required output column); any
        // column the upstream chain does NOT produce blocks the deploy.
        // Foundry itself tolerates ADDITIVE divergence (extra columns) —
        // those flow through PB-B10's classifier / warnings, never here.
        {
          const expectedColumns: string[] = (
            Array.isArray(cfg.expectedColumns) ? (cfg.expectedColumns as unknown[]) : []
          )
            .map((c: unknown) => (typeof c === 'string' ? c : (c as { name?: unknown })?.name))
            .filter((n): n is string => typeof n === 'string' && n.length > 0);
          if (expectedColumns.length > 0) {
            const produced = new Set(data.columns.map((c) => c.name));
            const missing = expectedColumns.filter((n) => !produced.has(n));
            if (missing.length > 0) {
              throw new AppError(
                `Cannot deploy output "${outputNode.label}": the following ${missing.length} ` +
                  `required column${missing.length === 1 ? ' is' : 's are'} not mapped: ` +
                  missing.join(', ') +
                  '. Map them in the output node before deploying.',
                400,
                'OUTPUT_COLUMNS_UNMAPPED',
                true,
                {
                  nodeId: outputNode.id,
                  missingColumns: missing,
                  missingCount: missing.length,
                  expectedCount: expectedColumns.length,
                  producedColumns: data.columns.map((c) => c.name),
                },
                'OutputColumnsUnmapped',
              );
            }
          }
        }

        // ── Foundry write modes + replay-on-deploy ───────────────────────
        // The output node's config chooses one of the seven documented
        // write modes; the transaction TYPE it produces is recorded with
        // the build (see recordOutputTransaction below). Previous view
        // rows come from the LATEST committed transaction on `master` —
        // Foundry semantics, the transaction log is authoritative, not
        // any denormalized cache of the dataset row.
        const existingDatasetId = cfg.outputDatasetId as string | undefined;
        const deployCfgRow = await this.knex('pipeline_deployments')
          .where({ id: deploymentId })
          .first('config');
        const deployConfig =
          typeof deployCfgRow?.config === 'string'
            ? JSON.parse(deployCfgRow.config)
            : (deployCfgRow?.config ?? {});
        const replayOnDeploy = deployConfig.replay === true;
        const writeModeConfig = {
          writeMode: (cfg.writeMode as string | undefined) ?? 'default',
          primaryKey: (cfg.primaryKey as string | undefined) ?? null,
          postFilteringColumn: (cfg.postFilteringColumn as string | undefined) ?? null,
        };
        validateWriteModeConfig(writeModeConfig);
        let buildTransactionType: 'SNAPSHOT' | 'APPEND' = 'SNAPSHOT';
        {
          let prevRows: Array<Record<string, unknown>> = [];
          if (existingDatasetId && !replayOnDeploy) {
            prevRows = await this.readLatestViewRows(existingDatasetId);
          }
          const applied = applyWriteMode({
            config: writeModeConfig,
            prevRows,
            newRows: data.rows,
            incrementalAppendEligible: await this.isIncrementalAppendEligible(pipelineId),
            replay: replayOnDeploy,
          });
          data = { ...data, rows: applied.rows, totalRows: applied.rows.length };
          buildTransactionType = applied.transactionType;
          if (replayOnDeploy) {
            console.log(
              `[deploy] replay-on-deploy: output "${outputNode.label}" produces a SNAPSHOT transaction`,
            );
          }
        }

        // ── Foundry data expectations ────────────────────────────────
        // Declarative data-quality rules evaluated against exactly the
        // rows this build would publish. severity='fail' BLOCKS the build
        // here — before any file/transaction commit — so a failing build
        // leaves the previously-healthy dataset untouched ('warn' records
        // but lets the build through).
        {
          const expRows = await this.knex('pipeline_expectations')
            .where({ pipeline_id: pipelineId, active: true })
            .where((q) =>
              q.whereNull('node_id').orWhere('node_id', outputNode.id),
            )
            .select('*');
          if (expRows.length > 0) {
            const { evaluateExpectations, mapExpectationRow } =
              await import('./pipelines/expectations');
            const expectationResults = evaluateExpectations(
              expRows.map(mapExpectationRow),
              data.rows,
            );
            await this.knex('pipeline_deployments')
              .where({ id: deploymentId })
              .update({ expectation_results: JSON.stringify(expectationResults) });
            const blocking = expectationResults.filter(
              (r) => r.status === 'FAIL' && r.severity === 'fail',
            );
            if (blocking.length > 0) {
              throw new AppError(
                `Cannot deploy output "${outputNode.label}": ${blocking.length} ` +
                  `data expectation${blocking.length === 1 ? '' : 's'} failed: ` +
                  blocking.map((r) => `${r.name} (${r.detail})`).join('; '),
                400,
                'EXPECTATIONS_FAILED',
                true,
                {
                  nodeId: outputNode.id,
                  failures: blocking.map((r) => ({ name: r.name, detail: r.detail })),
                },
                'ExpectationsFailed',
              );
            }
          }
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

        // Create or update output dataset (`existingDatasetId` resolved
        // earlier for the write-mode application).
        let datasetId: string;

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
          // Keep the dataset's display name in lock-step with the
          // output node's label. Without this, renaming the output
          // node on the canvas would write a new CSV at the new
          // sanitized filename but leave the project's file listing
          // showing the stale name from the first deploy — the user
          // sees the rename in the canvas but never in the file tree.
          // `original_filename` is already refreshed from `safeName`
          // below; pairing `name` with it keeps the two columns in
          // a consistent state across renames.
          // Foundry parity — the rename is subject to folder
          // name-uniqueness (ResourceNameAlreadyExists → 409).
          const currentDs = (await this.knex('foundry_datasets')
            .where({ id: existingDatasetId })
            .first('name', 'folder_id', 'project_id')) as
            | { name: string; folder_id: string | null; project_id: string | null }
            | undefined;
          if (currentDs && currentDs.name !== outputNode.label) {
            await assertFolderNameAvailable(this.knex, {
              name: outputNode.label,
              folderId: currentDs.folder_id ?? null,
              projectId: currentDs.project_id ?? projectId,
              excludeDatasetId: existingDatasetId,
            });
          }
          await this.knex('foundry_datasets')
            .where({ id: existingDatasetId })
            .update({
              name: outputNode.label,
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
          // Foundry parity — a new output lands in the pipeline's own
          // folder; its name must be unique among that folder's resources
          // (ResourceNameAlreadyExists → 409 otherwise).
          const outputFolderId = await this.resolveOutputFolderId(pipelineId, projectId);
          await assertFolderNameAvailable(this.knex, {
            name: outputNode.label,
            folderId: outputFolderId,
            projectId,
          });
          const [newDataset] = await this.knex('foundry_datasets')
            .insert({
              name: outputNode.label,
              project_id: projectId,
              folder_id: outputFolderId,
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

        // Foundry Datasets v2 — the build commits a transaction on the
        // output dataset's `master` branch, typed by the write mode (and
        // SNAPSHOT-forced when this deploy was a replay).
        await this.recordOutputTransaction({
          datasetId,
          deploymentId,
          pipelineId,
          outputNodeId: outputNode.id,
          filePath: s3Key,
          fileSizeBytes,
          rowCount: data.rows.length,
          columnCount: data.columns.length,
          createdBy: triggeredBy,
          transactionType: buildTransactionType,
          writeMode: writeModeConfig.writeMode ?? 'default',
          replay: replayOnDeploy,
        });

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
