import { createHash, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import ts from "typescript";
import {
  classifyFunctionKind,
  InvalidEditDeclarationError,
  type FunctionKind,
} from "./functionKind";

import type { StemmaAdapter, StemmaTreeEntry } from "../codeRepository/adapters/types";
import { compareSemver, isPreviewRelease, parseSemver } from "../functionsRegistry/semver";
import { listVersions, publishVersion } from "../functionsRegistry/store";
import {
  createS3FunctionArtifactStore,
  FUNCTION_ARTIFACT_MAX_SOURCE_BYTES,
  FUNCTION_ARTIFACT_MAX_SOURCE_FILES,
  type FunctionArtifactStore,
} from "../functionsRegistry/artifactStore";
import { mintFunctionVersionRid } from "../codeRepos/contracts/rid";
import {
  formatTypeCheckDiagnostic,
  typeCheckRepository,
  type TypeCheckSourceFile,
} from "./typeCheck";
import {
  resolveTestRunnerTunables,
  runRepositoryTests,
  type TestRunnerTunables,
} from "./testRunner";
import {
  AuthorityDeadline,
  classifyError,
  computeBackoffMs,
  describeTransientError,
  realSleep,
  resolveLifecycleTunables,
  RunAuthority,
  RunAuthorityLostError,
  TransientStageError,
  type LifecycleTunables,
} from "./retry";
import {
  compareSignaturesStructural,
  normalizeSignature,
} from "./signatureCompat";
import {
  canonicalTypeOfParameter,
  computeSignatureHash,
  readCanonicalSignature,
  TYPESCRIPT_V2_POSITIONAL_V2,
  type FunctionType,
  type InvocationContract,
} from "../functions/canonicalSignature";
import { parseFunctionPath } from "../functions/discovery";
import { inferFunctionObjectType } from "../codeRepository/functionObjectType";
import {
  startLogRetentionMaintenance,
  type MaintenanceHandle,
} from "./maintenance";

const STAGES = ["setup", "lint", "test", "build", "publish"] as const;
type Stage = (typeof STAGES)[number];

export interface EnqueuePublishArgs {
  repositoryRid: string;
  branch: string;
  defaultBranch: string;
  semver: string;
  message: string | null;
  triggeredBy: string;
  idempotencyKey: string;
}

export interface EnqueuedPublish {
  runRid: string;
  repositoryRid: string;
  branch: string;
  commitSha: string;
  semver: string;
  state: string;
  replayed: boolean;
}

export interface RetriggerPublishArgs {
  runRid: string;
  triggeredBy: string;
  idempotencyKey: string;
}

export interface RetriggeredPublish extends EnqueuedPublish {
  sourceRunRid: string;
}

export interface RetryEligibility {
  runRid: string;
  retryable: boolean;
  reason: "VERSION_OUTDATED" | null;
  attemptedSemver: string;
  latestSemver: string | null;
  suggestedSemver: string | null;
}

interface FunctionSource {
  apiName: string;
  path: string;
  source: string;
  signature: FunctionSignature;
  functionKind: FunctionKind;
}

/**
 * Persisted published signature. Each parameter carries the full canonical
 * contract (position/hasDefault/typeModel) in addition to the original
 * verbatim text fields — older consumers reading only {name,type,optional}
 * upgrade on read via canonicalSignature.readCanonicalSignature.
 */
interface FunctionSignature {
  parameters: Array<{
    name: string;
    type: string;
    optional: boolean;
    position: number;
    hasDefault: boolean;
    typeModel: FunctionType;
  }>;
  output: string;
}

/**
 * The complete publish-time metadata for one function — signature AND
 * declared kind, produced by ONE source analysis (the AST walk in
 * inspectPublishedFunction) and written to the registry in ONE
 * transaction (registerFunctions). Phase 4's signature-metadata
 * binding must read from this same write — do not add a second
 * publish-time parser or registry write path.
 */
export interface PublishedFunctionMetadata {
  signature: FunctionSignature;
  functionKind: FunctionKind;
}

interface PublishRequestRow {
  run_rid: string;
  repository_rid: string;
  branch: string;
  default_branch: string;
  semver: string;
  message: string | null;
  commit_sha: string;
}

/** Mutable per-execution context threaded through the stage chain. */
interface StageWork {
  activeStage: Stage;
  authority: RunAuthority;
  abortSignal: AbortSignal;
  request: PublishRequestRow | null;
  tree: { entries: readonly StemmaTreeEntry[]; branchHead: string } | null;
  functions: FunctionSource[];
  testSources: Array<{ path: string; source: string }>;
  canonical: string | null;
  artifactSha256: string | null;
  artifactBlobId: string | null;
}

/** A run this worker is currently executing (for shutdown drain). */
interface ActiveExecution {
  authority: RunAuthority;
  abort: AbortController;
  done: Promise<void>;
}

function requireRequest(work: StageWork): PublishRequestRow {
  if (!work.request) throw new Error("publish request metadata is missing");
  return work.request;
}

function requireTree(work: StageWork): { entries: readonly StemmaTreeEntry[]; branchHead: string } {
  if (!work.tree) throw new Error("repository checkout missing — setup stage did not run");
  return work.tree;
}

export class FunctionsPublishError extends Error {
  constructor(
    readonly code:
      | "BRANCH_NOT_FOUND"
      | "NO_FUNCTIONS"
      | "VERSION_CONFLICT"
      | "INVALID_FUNCTION"
      | "RUN_NOT_FOUND"
      | "RUN_NOT_TERMINAL"
      | "RUN_ALREADY_ACTIVE"
      | "RUN_NOT_RETRYABLE",
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "FunctionsPublishError";
  }
}

/**
 * Durable local worker for the functions-publish pipeline. Database leases and
 * SKIP LOCKED make claiming safe across API replicas. A production deployment
 * can replace only the execution adapter with Kubernetes while retaining the
 * same run, stage, log, and registry contracts.
 */
export class FunctionsPublishService {
  private readonly owner = `functions-publish-${process.pid}-${randomUUID()}`;
  private readonly running = new Set<string>();
  private readonly activeRuns = new Map<string, ActiveExecution>();
  private readonly testTunables: TestRunnerTunables;
  private readonly lifecycle: LifecycleTunables;
  private timer: NodeJS.Timeout | null = null;
  private maintenance: MaintenanceHandle | null = null;
  private stopped = false;
  private stopPromise: Promise<void> | null = null;

  private readonly artifacts: FunctionArtifactStore;

  constructor(
    private readonly deps: { pool: Pool; stemma: StemmaAdapter; artifacts?: FunctionArtifactStore },
    private readonly concurrency = Math.max(1, Number(process.env.FUNCTIONS_PUBLISH_CONCURRENCY ?? 2)),
    testTunables: Partial<TestRunnerTunables> = {},
    lifecycleTunables: Partial<LifecycleTunables> = {},
  ) {
    // Env-resolved defaults (FUNCTIONS_PUBLISH_TEST_TIMEOUT_MS etc.) with a
    // constructor override hook for tests — same DI convention as
    // `concurrency` above.
    this.testTunables = { ...resolveTestRunnerTunables(), ...testTunables };
    this.lifecycle = { ...resolveLifecycleTunables(), ...lifecycleTunables };
    // Production default: the real S3/MinIO object store. Tests may
    // inject a hermetic store — but the codeRepos integration lane
    // exercises the real one (MinIO runs in docker-compose).
    this.artifacts = deps.artifacts ?? createS3FunctionArtifactStore();
  }

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => void this.pump(), 1_000);
    this.timer.unref();
    // Bounded log retention + orphan-artifact sweep (Track 2 #9).
    // Advisory-locked: a multi-replica fleet runs exactly one
    // cleanup at a time. Failures never affect publishing.
    this.maintenance = startLogRetentionMaintenance(this.deps.pool);
    void this.pump();
  }

  /**
   * Abort-and-drain shutdown.
   *
   * Stops claiming new work, signals authority loss to every active
   * execution (interrupting backoff and killing any test subprocess
   * group), then waits for them to settle up to shutdownGraceMs.
   * Heartbeats keep renewing until each execute() acknowledges and
   * stops in its own finally — the run is NEVER marked CANCELLED or
   * FAILED by a worker shutdown; the lease simply lapses afterwards
   * so another worker can reclaim the still-RUNNING run.
   * Idempotent: a second call returns the same drain promise.
   */
  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = (async () => {
      this.stopped = true;
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
      this.maintenance?.stop();
      this.maintenance = null;
      const active = [...this.activeRuns.entries()];
      for (const [runRid, entry] of active) {
        this.loseAuthority(runRid, entry.authority, "shutdown");
        entry.abort.abort(new RunAuthorityLostError("shutdown"));
      }
      await Promise.race([
        Promise.allSettled(active.map(([, entry]) => entry.done)),
        realSleep(this.lifecycle.shutdownGraceMs),
      ]);
    })();
    return this.stopPromise;
  }

  async enqueue(args: EnqueuePublishArgs): Promise<EnqueuedPublish> {
    parseSemver(args.semver);
    const tree = await this.deps.stemma.listTree({
      repositoryRid: args.repositoryRid,
      branch: args.branch,
      path: "",
      depth: 6,
    });
    if (tree.kind === "branch-not-found") {
      throw new FunctionsPublishError("BRANCH_NOT_FOUND", `Branch ${args.branch} was not found`);
    }
    if (tree.kind !== "ok") throw new Error(`Unable to read repository tree: ${tree.kind}`);

    const paths = discoverTypeScriptV2FunctionPaths(tree.entries.map((entry) => ({ path: entry.path, type: entry.type })));
    if (paths.length === 0) {
      throw new FunctionsPublishError(
        "NO_FUNCTIONS",
        "No TypeScript v2 functions were found under typescript-functions/src/functions",
      );
    }

    // Reject an obsolete release before creating a durable job. Version-floor
    // failures are deterministic, so queueing them only produces misleading
    // work and a Retrigger loop that can never succeed.
    const versionFloor = await this.latestVersionEligibility(
      args.repositoryRid,
      args.branch,
      args.semver,
    );
    if (!versionFloor.retryable) {
      throw new FunctionsPublishError(
        "VERSION_CONFLICT",
        `Version ${args.semver} is lower than the latest release ${versionFloor.latestSemver}`,
        { ...versionFloor },
      );
    }

    const existing = await this.deps.pool.query(
      `SELECT r.rid, r.repository_rid, r.ref, r.commit_sha, r.state
         FROM function_publish_request p
         JOIN jemma_run r ON r.rid = p.run_rid
        WHERE p.repository_rid = $1 AND p.branch = $2 AND p.semver = $3`,
      [args.repositoryRid, args.branch, args.semver],
    );
    if (existing.rowCount) {
      const row = existing.rows[0];
      return {
        runRid: row.rid,
        repositoryRid: row.repository_rid,
        branch: row.ref,
        commitSha: row.commit_sha,
        semver: args.semver,
        state: row.state,
        replayed: true,
      };
    }

    // Active-run guard (Track 2 #7): at most one active run per
    // (repository, branch) — the same rule retrigger enforces.
    // This pre-check produces the informative response; the partial
    // unique index jemma_run_active_per_ref_uq remains the final
    // concurrency authority (race loser is mapped below — a raw
    // 23505 never escapes as an HTTP 500).
    const active = await this.deps.pool.query<{ rid: string }>(
      `SELECT rid FROM jemma_run
        WHERE repository_rid = $1 AND ref = $2
          AND state IN ('QUEUED','RUNNING')
        LIMIT 1`,
      [args.repositoryRid, args.branch],
    );
    if (active.rows[0]) {
      // Bounded operational log — one line per conflict, run
      // rids only (no SQL, no principal data).
      console.warn(
        `functions-publish: enqueue rejected — active run ${active.rows[0].rid} for ${args.repositoryRid}@${args.branch}`,
      );
      throw new FunctionsPublishError(
        "RUN_ALREADY_ACTIVE",
        "A functions-publish run is already active for this repository branch",
        { activeRunRid: active.rows[0].rid },
      );
    }

    const runRid = `ri.jemma.main.run.${randomUUID()}`;
    const client = await this.deps.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO jemma_run (
           rid, repository_rid, ref, commit_sha, trigger_kind, triggered_by,
           state, idempotency_key, job_name
         ) VALUES ($1,$2,$3,$4,'TAG',$5,'QUEUED',$6,'functions-publish')`,
        [runRid, args.repositoryRid, args.branch, tree.branchHead, args.triggeredBy, args.idempotencyKey],
      );
      for (const stage of STAGES) {
        await client.query(
          `INSERT INTO jemma_run_stage(run_rid, stage_name, state) VALUES ($1,$2,'PENDING')`,
          [runRid, stage],
        );
      }
      await client.query(
        `INSERT INTO function_publish_request(
           run_rid, repository_rid, branch, semver, message, default_branch
         ) VALUES ($1,$2,$3,$4,$5,$6)`,
        [runRid, args.repositoryRid, args.branch, args.semver, args.message, args.defaultBranch],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      if (isPgUniqueViolation(error, "jemma_run_active_per_ref_uq")) {
        // Lost the race against a concurrent enqueue/retrigger: the
        // winner inserted between our pre-check and our INSERT.
        // Resolve the winner deterministically — same-semver races
        // replay (dedup semantics), different-semver races conflict.
        const winner = await this.deps.pool.query<{
          rid: string;
          repository_rid: string;
          ref: string;
          commit_sha: string;
          state: string;
          semver: string;
        }>(
          `SELECT r.rid, r.repository_rid, r.ref, r.commit_sha, r.state, p.semver
             FROM jemma_run r
             JOIN function_publish_request p ON p.run_rid = r.rid
            WHERE r.repository_rid = $1 AND r.ref = $2
              AND r.state IN ('QUEUED','RUNNING')
            LIMIT 1`,
          [args.repositoryRid, args.branch],
        ).catch(() => null);
        const won = winner?.rows[0];
        if (won && won.semver === args.semver) {
          return {
            runRid: won.rid,
            repositoryRid: won.repository_rid,
            branch: won.ref,
            commitSha: won.commit_sha,
            semver: args.semver,
            state: won.state,
            replayed: true,
          };
        }
        console.warn(
          `functions-publish: enqueue lost the active-run race for ${args.repositoryRid}@${args.branch} (winner ${won?.rid ?? "unknown"})`,
        );
        throw new FunctionsPublishError(
          "RUN_ALREADY_ACTIVE",
          "A functions-publish run is already active for this repository branch",
          won ? { activeRunRid: won.rid } : {},
        );
      }
      throw error;
    } finally {
      client.release();
    }
    await this.log(runRid, null, "system", `Starting job ${runRid}`);
    await this.log(runRid, null, "system", `Queued functions-publish for ${args.repositoryRid} @ ${tree.branchHead}`);
    void this.pump();
    return {
      runRid,
      repositoryRid: args.repositoryRid,
      branch: args.branch,
      commitSha: tree.branchHead,
      semver: args.semver,
      state: "QUEUED",
      replayed: false,
    };
  }

  /**
   * Cancel a run and leave a coherent terminal snapshot in ONE
   * transaction: run CANCELLED (lease cleared), the currently
   * RUNNING stage and all PENDING stages become SKIPPED with
   * finished_at set — no stage is ever left RUNNING under a
   * terminal run. (jemma_run_stage's CHECK supports
   * PENDING|RUNNING|SUCCEEDED|FAILED|SKIPPED; SKIPPED is the
   * repository's cancellation-compatible terminal stage state.)
   *
   * Idempotent: a terminal run matches no rows, so a repeated
   * cancel mutates nothing and appends no duplicate log line.
   * If THIS worker owns the run, local execution is aborted
   * immediately (test subprocess group killed) rather than
   * waiting for the next heartbeat tick.
   */
  async cancel(runRid: string): Promise<boolean> {
    const client = await this.deps.pool.connect();
    let cancelled = false;
    try {
      await client.query("BEGIN");
      const result = await client.query(
        `UPDATE jemma_run
            SET state = 'CANCELLED', finished_at = now(), failure_reason = 'cancelled-by-user',
                lease_owner = NULL, lease_expires_at = NULL, resource_version = resource_version + 1,
                updated_at = now()
          WHERE rid = $1 AND job_name = 'functions-publish' AND state IN ('QUEUED','RUNNING')`,
        [runRid],
      );
      if (result.rowCount) {
        cancelled = true;
        await client.query(
          `UPDATE jemma_run_stage SET state = 'SKIPPED', finished_at = now()
            WHERE run_rid = $1 AND state IN ('PENDING','RUNNING')`,
          [runRid],
        );
        await client.query(
          `INSERT INTO jemma_run_log(run_rid, stage_name, stream, message)
           VALUES ($1, NULL, 'system', 'Cancellation requested by user')`,
          [runRid],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    if (cancelled) {
      const entry = this.activeRuns.get(runRid);
      if (entry) {
        entry.authority.lose("cancelled");
        entry.abort.abort(new RunAuthorityLostError("cancelled"));
      }
    }
    return cancelled;
  }

  async getRetryEligibility(runRid: string): Promise<RetryEligibility> {
    const sourceResult = await this.deps.pool.query<{
      repository_rid: string;
      branch: string;
      semver: string;
    }>(
      `SELECT p.repository_rid, p.branch, p.semver
         FROM function_publish_request p
         JOIN jemma_run r ON r.rid = p.run_rid
        WHERE p.run_rid = $1 AND r.job_name = 'functions-publish'`,
      [runRid],
    );
    const source = sourceResult.rows[0];
    if (!source) {
      throw new FunctionsPublishError("RUN_NOT_FOUND", "Functions publish run was not found");
    }
    return this.latestVersionEligibility(
      source.repository_rid,
      source.branch,
      source.semver,
      runRid,
    );
  }

  /**
   * Create a new durable attempt from a terminal functions-publish run.
   *
   * The source run is never mutated: its stages and logs remain an immutable
   * audit record. The new run keeps the same repository/ref/commit/SemVer and
   * release message, while recording the requesting principal and a MANUAL
   * trigger. A principal-scoped idempotency key makes browser/network retries
   * return the same new attempt.
   */
  async retrigger(args: RetriggerPublishArgs): Promise<RetriggeredPublish> {
    const client = await this.deps.pool.connect();
    let result: RetriggeredPublish;
    try {
      await client.query("BEGIN");
      const sourceResult = await client.query<{
        repository_rid: string;
        ref: string;
        commit_sha: string;
        state: string;
        semver: string;
        message: string | null;
        default_branch: string;
      }>(
        `SELECT r.repository_rid, r.ref, r.commit_sha, r.state,
                p.semver, p.message, p.default_branch
           FROM jemma_run r
           JOIN function_publish_request p ON p.run_rid = r.rid
          WHERE r.rid = $1 AND r.job_name = 'functions-publish'
          FOR UPDATE OF r`,
        [args.runRid],
      );
      const source = sourceResult.rows[0];
      if (!source) {
        throw new FunctionsPublishError("RUN_NOT_FOUND", "Functions publish run was not found");
      }
      if (!isTerminalRunState(source.state)) {
        throw new FunctionsPublishError("RUN_NOT_TERMINAL", "Only terminal runs can be retriggered", {
          state: source.state,
        });
      }

      const replay = await client.query<{
        rid: string;
        state: string;
      }>(
        `SELECT r.rid, r.state
           FROM jemma_run r
           JOIN function_publish_request p ON p.run_rid = r.rid
          WHERE p.retry_of_run_rid = $1
            AND r.triggered_by = $2
            AND r.idempotency_key = $3
          LIMIT 1`,
        [args.runRid, args.triggeredBy, args.idempotencyKey],
      );
      if (replay.rows[0]) {
        await client.query("COMMIT");
        return {
          runRid: replay.rows[0].rid,
          sourceRunRid: args.runRid,
          repositoryRid: source.repository_rid,
          branch: source.ref,
          commitSha: source.commit_sha,
          semver: source.semver,
          state: replay.rows[0].state,
          replayed: true,
        };
      }

      const publishedVersions = await client.query<{ semver: string }>(
        `SELECT semver FROM function_version
          WHERE repository_rid = $1 AND branch = $2 AND state = 'AVAILABLE'`,
        [source.repository_rid, source.ref],
      );
      const eligibility = retryEligibility(
        args.runRid,
        source.semver,
        publishedVersions.rows.map((row) => row.semver),
      );
      if (!eligibility.retryable) {
        throw new FunctionsPublishError(
          "RUN_NOT_RETRYABLE",
          `Version ${source.semver} is lower than the latest release ${eligibility.latestSemver}`,
          { ...eligibility },
        );
      }

      const active = await client.query<{ rid: string }>(
        `SELECT rid FROM jemma_run
          WHERE repository_rid = $1 AND ref = $2
            AND state IN ('QUEUED','RUNNING')
          LIMIT 1`,
        [source.repository_rid, source.ref],
      );
      if (active.rows[0]) {
        throw new FunctionsPublishError(
          "RUN_ALREADY_ACTIVE",
          "A functions-publish run is already active for this repository branch",
          { activeRunRid: active.rows[0].rid },
        );
      }

      const runRid = `ri.jemma.main.run.${randomUUID()}`;
      await client.query(
        `INSERT INTO jemma_run (
           rid, repository_rid, ref, commit_sha, trigger_kind, triggered_by,
           state, idempotency_key, job_name
         ) VALUES ($1,$2,$3,$4,'MANUAL',$5,'QUEUED',$6,'functions-publish')`,
        [
          runRid,
          source.repository_rid,
          source.ref,
          source.commit_sha,
          args.triggeredBy,
          args.idempotencyKey,
        ],
      );
      for (const stage of STAGES) {
        await client.query(
          `INSERT INTO jemma_run_stage(run_rid, stage_name, state) VALUES ($1,$2,'PENDING')`,
          [runRid, stage],
        );
      }
      await client.query(
        `INSERT INTO function_publish_request(
           run_rid, repository_rid, branch, semver, message, default_branch,
           retry_of_run_rid
         ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          runRid,
          source.repository_rid,
          source.ref,
          source.semver,
          source.message,
          source.default_branch,
          args.runRid,
        ],
      );
      await client.query("COMMIT");
      result = {
        runRid,
        sourceRunRid: args.runRid,
        repositoryRid: source.repository_rid,
        branch: source.ref,
        commitSha: source.commit_sha,
        semver: source.semver,
        state: "QUEUED",
        replayed: false,
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      if (isPgUniqueViolation(error, "jemma_run_active_per_ref_uq")) {
        throw new FunctionsPublishError(
          "RUN_ALREADY_ACTIVE",
          "A functions-publish run is already active for this repository branch",
        );
      }
      throw error;
    } finally {
      client.release();
    }

    await this.log(result.runRid, null, "system", `Retriggered from job ${args.runRid}`);
    await this.log(result.runRid, null, "system", `Starting job ${result.runRid}`);
    void this.pump();
    return result;
  }

  private async latestVersionEligibility(
    repositoryRid: string,
    branch: string,
    attemptedSemver: string,
    runRid = "",
  ): Promise<RetryEligibility> {
    const versions = await this.deps.pool.query<{ semver: string }>(
      `SELECT semver FROM function_version
        WHERE repository_rid = $1 AND branch = $2 AND state = 'AVAILABLE'`,
      [repositoryRid, branch],
    );
    return retryEligibility(
      runRid,
      attemptedSemver,
      versions.rows.map((row) => row.semver),
    );
  }

  private async pump(): Promise<void> {
    if (this.stopped) return;
    try {
      while (this.running.size < this.concurrency) {
        const runRid = await this.claim();
        if (!runRid) return;
        this.running.add(runRid);
        const entry: ActiveExecution = {
          authority: new RunAuthority(),
          abort: new AbortController(),
          done: Promise.resolve(),
        };
        entry.done = this.execute(runRid, entry.authority, entry.abort.signal)
          .finally(() => {
            this.activeRuns.delete(runRid);
            this.running.delete(runRid);
            void this.pump();
          });
        this.activeRuns.set(runRid, entry);
      }
    } catch (error) {
      // Poll-loop resilience: pump() is always fired-and-forgotten
      // (`void this.pump()` from start(), enqueue(), and execution
      // settle), so a rejected claim — transient DB outage, or a
      // pool draining during shutdown — would otherwise surface as
      // an unhandled rejection and crash the worker process. The
      // claim is idempotent (FOR UPDATE SKIP LOCKED): the next 1s
      // interval tick or enqueue-triggered pump retries. Bounded
      // log: classification only, no run ids, no SQL.
      if (!this.stopped) {
        console.warn(
          `functions-publish: claim pump failed (${classifyError(error)}); retrying on next tick`,
        );
      }
    }
  }

  private async claim(): Promise<string | null> {
    const result = await this.deps.pool.query<{ rid: string }>(
      `WITH candidate AS (
         SELECT rid FROM jemma_run
          WHERE job_name = 'functions-publish'
            AND (state = 'QUEUED' OR (state = 'RUNNING' AND lease_expires_at < now()))
          ORDER BY queued_at ASC
          FOR UPDATE SKIP LOCKED LIMIT 1
       )
       UPDATE jemma_run r
          SET state = 'RUNNING', started_at = COALESCE(started_at, now()),
              pod_name = $1, lease_owner = $1,
              lease_expires_at = now() + ($2::bigint * interval '1 millisecond'),
              resource_version = resource_version + 1, updated_at = now()
         FROM candidate c WHERE r.rid = c.rid
       RETURNING r.rid`,
      // One lease-TTL source of truth shared with renewal (retry.ts
      // tunables) — claim and heartbeat can never drift apart.
      [this.owner, this.lifecycle.leaseTtlMs],
    );
    return result.rows[0]?.rid ?? null;
  }

  private async execute(runRid: string, authority: RunAuthority, abortSignal: AbortSignal): Promise<void> {
    const heartbeat = this.startHeartbeat(runRid, authority);
    const work: StageWork = {
      activeStage: "setup",
      authority,
      abortSignal,
      request: null,
      tree: null,
      functions: [],
      testSources: [],
      canonical: null,
      artifactSha256: null,
      artifactBlobId: null,
    };
    try {
      const requestResult = await this.deps.pool.query<PublishRequestRow>(
        `SELECT p.run_rid, p.repository_rid, p.branch, p.default_branch, p.semver,
                p.message, r.commit_sha
           FROM function_publish_request p JOIN jemma_run r ON r.rid = p.run_rid
          WHERE p.run_rid = $1`,
        [runRid],
      );
      const request = requestResult.rows[0];
      if (!request) throw new Error("publish request metadata is missing");
      work.request = request;

      await this.executeStage(runRid, authority, work, "setup", () => this.stageSetup(runRid, work));
      await this.executeStage(runRid, authority, work, "lint", () => this.stageLint(runRid, work));
      await this.executeStage(runRid, authority, work, "test", () => this.stageTest(runRid, work));
      await this.executeStage(runRid, authority, work, "build", () => this.stageBuild(runRid, work));
      await this.executeStage(runRid, authority, work, "publish", () => this.stagePublish(runRid, work));

      // Finalize and log in ONE statement: the terminal log line can
      // never be written by a worker that failed to finalize, and a
      // successful finalize can never lose its terminal line.
      const finalized = await this.deps.pool.query(
        `WITH done AS (
           UPDATE jemma_run
              SET state = 'SUCCEEDED', finished_at = now(), exit_code = 0,
                  lease_owner = NULL, lease_expires_at = NULL,
                  resource_version = resource_version + 1, updated_at = now()
            WHERE rid = $1 AND lease_owner = $2 AND state = 'RUNNING'
           RETURNING rid
         )
         INSERT INTO jemma_run_log(run_rid, stage_name, stream, message)
         SELECT $1, NULL, 'system', 'BUILD SUCCESSFUL' FROM done`,
        [runRid, this.owner],
      );
      if (finalized.rowCount === 0) throw await this.authorityError(runRid);
    } catch (error) {
      if (error instanceof RunAuthorityLostError) {
        // Cancellation or lease loss: the canceller (or the worker that
        // reclaimed the lease) drives the lifecycle now. This worker
        // must not write FAILED, skip stages, or log anything further.
        return;
      }
      try {
        await this.failRun(runRid, work.activeStage, error);
      } catch {
        // The DB itself may be down. The lease TTL expires and another
        // worker reclaims the run — no false terminal state is written.
      }
    } finally {
      await heartbeat.stop();
    }
  }

  /**
   * Run one stage with stage-scoped transient retry.
   *
   * Previously succeeded stages are never re-entered; the current stage
   * stays RUNNING (never transiently FAILED) across attempts; the run
   * stays RUNNING with the lease held and renewed through backoff.
   */
  private async executeStage(
    runRid: string,
    authority: RunAuthority,
    work: StageWork,
    stage: Stage,
    body: () => Promise<void>,
  ): Promise<void> {
    work.activeStage = stage;
    authority.throwIfLost();
    for (;;) {
      try {
        await this.stageStarted(runRid, stage);
        await body();
        // Re-check authority after the stage body: a long-running
        // body that lost local authority mid-way (deadline expired,
        // cancel, shutdown) must not mark the stage succeeded.
        authority.throwIfLost();
        await this.stageSucceeded(runRid, stage);
        return;
      } catch (error) {
        // Classify BEFORE mutating any stage/run/retry state.
        if (error instanceof RunAuthorityLostError) throw error;
        if (classifyError(error) !== "transient") throw error;
        const reservation = await this.reserveRetry(runRid);
        if (reservation.kind === "exhausted") throw error;
        if (reservation.kind === "authority-lost") throw reservation.error;
        const summary = (error instanceof Error ? error.message : String(error)).slice(0, 200);
        await this.logAuthoritative(
          runRid,
          stage,
          "system",
          `Transient error (${describeTransientError(error)}); retry ${reservation.retryNumber} of `
            + `${this.lifecycle.maxTransientRetries} after ${reservation.delayMs}ms backoff — ${summary}`,
        );
        await this.waitBackoff(reservation.delayMs, authority);
        // Loop re-enters stageStarted, which re-asserts authority.
      }
    }
  }

  private async stageSetup(runRid: string, work: StageWork): Promise<void> {
    const request = requireRequest(work);
    const tree = await this.deps.stemma.listTree({
      repositoryRid: request.repository_rid,
      branch: request.branch,
      path: "",
      depth: 6,
    });
    if (tree.kind === "transient") throw new TransientStageError("repository checkout failed: transient stemma error");
    if (tree.kind !== "ok") throw new Error(`repository checkout failed: ${tree.kind}`);
    if (tree.branchHead !== request.commit_sha) {
      throw new Error(`branch moved: expected ${request.commit_sha}, found ${tree.branchHead}`);
    }
    work.tree = { entries: tree.entries, branchHead: tree.branchHead };
    const paths = discoverTypeScriptV2FunctionPaths(tree.entries.map((entry) => ({ path: entry.path, type: entry.type })));
    // Bounded artifact inputs (Track 2 #8): the publish bundle
    // holds every source, so file count and per-file size are
    // hard limits — deterministic failure, never truncation.
    if (paths.length > FUNCTION_ARTIFACT_MAX_SOURCE_FILES) {
      throw new Error(
        `repository declares ${paths.length} function files, above the ${FUNCTION_ARTIFACT_MAX_SOURCE_FILES}-file limit`,
      );
    }
    await this.logAuthoritative(runRid, "setup", "stdout", `Cloning repository ${request.repository_rid}.`);
    await this.logAuthoritative(runRid, "setup", "stdout", `Checked out ${request.branch} at ${request.commit_sha}.`);
    // Reset per attempt — a retried stage must not accumulate state.
    work.functions = [];
    for (const path of paths) {
      // Local authority check between blob reads — a worker past its
      // confirmed lease horizon must not keep doing external I/O.
      work.authority.throwIfLost();
      // Path-traversal guard: a tree entry must be a plain
      // relative POSIX path before it becomes a bundle key.
      if (!/^[A-Za-z0-9_./-]+$/.test(path) || path.split("/").includes("..")) {
        throw new Error(`invalid function path: ${JSON.stringify(path.slice(0, 200))}`);
      }
      const blob = await this.deps.stemma.readBlob({
        repositoryRid: request.repository_rid,
        branch: request.branch,
        path,
      });
      if (blob.kind === "transient") throw new TransientStageError(`source unreadable (transient): ${path}`);
      if (blob.kind !== "ok") throw new Error(`source unreadable: ${path}`);
      if (blob.content.byteLength > FUNCTION_ARTIFACT_MAX_SOURCE_BYTES) {
        throw new Error(
          `function source ${path} is ${blob.content.byteLength} bytes, above the ${FUNCTION_ARTIFACT_MAX_SOURCE_BYTES}-byte limit`,
        );
      }
      const source = new TextDecoder().decode(blob.content);
      const metadata = inspectPublishedFunction(path, source);
      work.functions.push({
        // Foundry parity: identity is the path relative to src/functions/
        // WITHOUT the extension — root-level files keep their historic
        // basename ("calc"), nested files are namespaced ("orders/calc"), so
        // same-named files in different folders never collide. See
        // functions/discovery.ts.
        apiName: parseFunctionPath(path)?.apiName ?? fileStem(path),
        path,
        source,
        signature: metadata.signature,
        functionKind: metadata.functionKind,
      });
    }
  }

  private async stageLint(runRid: string, work: StageWork): Promise<void> {
    const request = requireRequest(work);
    const tree = requireTree(work);
    await this.logAuthoritative(runRid, "lint", "stdout", `Discovered ${work.functions.length} TypeScript v2 function(s).`);
    // Test sources are loaded once here and reused by the test stage —
    // no duplicate blob reads within a run.
    work.testSources = await this.readTestSources(request, tree.entries);
    // Local authority check before CPU-intensive compilation.
    work.authority.throwIfLost();
    const typeCheck = typeCheckRepository([
      ...work.functions.map((fn): TypeCheckSourceFile => ({ path: fn.path, source: fn.source, kind: "function" })),
      ...work.testSources.map((file): TypeCheckSourceFile => ({ ...file, kind: "test" })),
    ]);
    if (!typeCheck.ok) {
      for (const diagnostic of typeCheck.diagnostics) {
        await this.logAuthoritative(runRid, "lint", "stderr", formatTypeCheckDiagnostic(diagnostic));
      }
      if (typeCheck.truncatedCount > 0) {
        await this.logAuthoritative(runRid, "lint", "stderr", `… ${typeCheck.truncatedCount} further diagnostic(s) omitted`);
      }
      throw new FunctionsPublishError(
        "INVALID_FUNCTION",
        `TypeScript type-check failed with ${typeCheck.diagnostics.length + typeCheck.truncatedCount} error(s)`,
        { diagnostics: typeCheck.diagnostics.map(formatTypeCheckDiagnostic) },
      );
    }
    await this.logAuthoritative(runRid, "lint", "stdout",
      `TypeScript type-check passed for ${work.functions.length} function(s) and ${work.testSources.length} test file(s).`);
  }

  private async stageTest(runRid: string, work: StageWork): Promise<void> {
    if (work.testSources.length === 0) {
      // Zero-test policy (unchanged from the previous stage semantics):
      // no discovered tests is not a failure — lint already type-checked
      // the repository's sources.
      await this.logAuthoritative(runRid, "test", "stdout", "No test files were discovered; repository compile checks passed.");
      return;
    }
    // Local authority check before spawning user code — and the
    // abort signal kills the child group if authority is lost
    // mid-run (cancel, lease loss, shutdown).
    work.authority.throwIfLost();
    const testResult = await runRepositoryTests(
      [
        ...work.functions.map((fn) => ({ path: fn.path, source: fn.source })),
        ...work.testSources,
      ],
      this.testTunables,
      work.abortSignal,
    );
    // Re-check immediately after the subprocess returns: a worker
    // that lost authority mid-test must not record a stage result.
    work.authority.throwIfLost();
    for (const failure of testResult.failures) {
      await this.logAuthoritative(runRid, "test", "stderr", failure);
    }
    if (testResult.status !== "passed") {
      throw new Error(
        `tests failed: ${testResult.failedCount} of ${testResult.testCount} test(s) failed across ${testResult.fileCount} test file(s)`,
      );
    }
    await this.logAuthoritative(runRid, "test", "stdout",
      `Executed ${testResult.testCount} test(s) across ${testResult.fileCount} test file(s) in ${Math.round(testResult.durationMs)}ms: ${testResult.passedCount} passed.`);
  }

  private async stageBuild(runRid: string, work: StageWork): Promise<void> {
    const canonical = JSON.stringify({
      exports: work.functions.map((fn) => fn.apiName),
      sources: Object.fromEntries(work.functions.map((fn) => [fn.apiName, fn.source])),
      signatures: Object.fromEntries(work.functions.map((fn) => [fn.apiName, fn.signature])),
    });
    work.canonical = canonical;
    work.artifactSha256 = createHash("sha256").update(canonical).digest("hex");
    // Track 2 #8: persist the bundle as a real immutable,
    // content-addressed object. Upload is idempotent (digest-keyed,
    // head-before-upload dedup), so a retried build stage is safe.
    // An orphan blob is possible if the later DB transaction rolls
    // back — sweepOrphanedFunctionArtifacts reclaims those.
    const put = await this.artifacts.put({ digest: work.artifactSha256, bundle: canonical });
    work.artifactBlobId = put.blobId;
    await this.logAuthoritative(runRid, "build", "stdout",
      `Created content-addressed bundle sha256:${work.artifactSha256}.`);
    await this.logAuthoritative(runRid, "build", "stdout",
      put.deduplicated
        ? `Artifact already stored as ${put.blobId} (deduplicated).`
        : `Stored artifact ${put.blobId} (${put.storedBytes} bytes).`);
  }

  private async stagePublish(runRid: string, work: StageWork): Promise<void> {
    const request = requireRequest(work);
    const canonical = work.canonical ?? "";
    const artifactSha256 = work.artifactSha256 ?? "";
    // Re-assert authority immediately before externally visible side
    // effects — a cancelled/reclaimed run must not publish.
    await this.assertAuthority(runRid);
    try {
      await validateCompatibility(this.deps.pool, request.repository_rid, request.branch, request.semver, work.functions);
    } catch (error) {
      // Surface the full breaking-change list in the run log, not just the
      // top-line "Backward-incompatible changes require a major release"
      // message — operators diagnosing a failed publish need the detail.
      if (error instanceof FunctionsPublishError && Array.isArray(error.details.breaking)) {
        await this.logAuthoritative(
          runRid,
          "publish",
          "stderr",
          error.details.breaking.map((line) => String(line)).join("; "),
        );
      }
      throw error;
    }
    const isPreview = isPreviewRelease(request.branch, request.default_branch, request.semver);
    // The bundle (with full sources) lives in the artifact blob
    // store — the manifest carries only compact metadata. Source
    // reads go through resolveFunctionSource(s) (artifactStore),
    // which also serves historical inline manifests. NO inline
    // fallback is written for new versions.
    const artifactBlobId = work.artifactBlobId;
    if (!artifactBlobId) throw new Error("artifact blob missing — build stage did not run");
    const manifest = {
      exports: work.functions.map((fn) => fn.apiName),
      signatures: Object.fromEntries(work.functions.map((fn) => [fn.apiName, fn.signature])),
      // Normalized structural form (Track 2 #6) — additive and
      // optional; historical manifests carry only `signatures`
      // and remain readable (comparison normalizes on read).
      signaturesNormalized: Object.fromEntries(
        work.functions.map((fn) => [fn.apiName, normalizeSignature(fn.signature)]),
      ),
      sourcePaths: Object.fromEntries(work.functions.map((fn) => [fn.apiName, fn.path])),
      // Ontology binding captured AT PUBLISH TIME — the Published tab serves
      // this from the immutable manifest, so a later working-tree refactor
      // can never mislabel a released version. null = pure utility.
      objectTypes: Object.fromEntries(
        work.functions.map((fn) => [fn.apiName, inferFunctionObjectType(fn.source)]),
      ),
      artifactFormat: "functions-publish-bundle/v1",
      runtime: "NODE_20",
      functionCount: work.functions.length,
      message: request.message,
    };
    // publishVersion is idempotent on (repository, branch, semver) +
    // artifact_sha256 — safe under ambiguous-commit retry (dedup) —
    // and registerFunctions is a single transaction of upserts.
    const published = await publishVersion(this.deps.pool, {
      rid: mintFunctionVersionRid(),
      repositoryRid: request.repository_rid,
      branch: request.branch,
      isPreview,
      semver: request.semver,
      commitSha: request.commit_sha,
      runtime: "NODE_20",
      artifactBlobId,
      artifactSha256,
      artifactBytes: Buffer.byteLength(canonical),
      manifest,
    });
    if (published.outcome === "immutable-conflict") throw new Error("version exists with a different immutable artifact");
    const functionRids = await this.registerFunctions(request, work.functions, published.row.rid, artifactSha256);
    await this.deps.pool.query(
      `UPDATE function_publish_request
          SET version_rid = $2, artifact_sha256 = $3, function_rids = $4::jsonb, updated_at = now()
        WHERE run_rid = $1`,
      [runRid, published.row.rid, artifactSha256, JSON.stringify(functionRids)],
    );
    for (const fn of work.functions) {
      await this.logAuthoritative(runRid, "publish", "stdout", `Registered ${fn.apiName} with rid '${functionRids[fn.apiName]}'.`);
    }
  }

  private async registerFunctions(
    request: PublishRequestRow,
    functions: FunctionSource[],
    releaseVersionRid: string,
    artifactSha256: string,
  ): Promise<Record<string, string>> {
    const client = await this.deps.pool.connect();
    const result: Record<string, string> = {};
    try {
      await client.query("BEGIN");
      for (const fn of functions) {
        const existing = await client.query<{ rid: string }>(
          `SELECT rid FROM function_registry_function WHERE repository_rid = $1 AND source_path = $2`,
          [request.repository_rid, fn.path],
        );
        const rid = existing.rows[0]?.rid ?? `ri.function-registry.main.function.${randomUUID()}`;
        await client.query(
          `INSERT INTO function_registry_function(rid, repository_rid, api_name, display_name, source_path)
           VALUES ($1,$2,$3,$3,$4)
           ON CONFLICT(repository_rid, source_path) DO UPDATE
             SET api_name = EXCLUDED.api_name, display_name = EXCLUDED.display_name,
                 retired_at = NULL, updated_at = now()`,
          [rid, request.repository_rid, fn.apiName, fn.path],
        );
        // The invocation contract is persisted per immutable published
        // version. All NEW publishes use the positional TypeScript v2
        // contract; artifacts published before the contract column existed
        // are backfilled (migration 156) to legacy-object-envelope-v1 and
        // keep their original behavior byte-identically.
        const invocationContract: InvocationContract = TYPESCRIPT_V2_POSITIONAL_V2;
        const canonical = readCanonicalSignature(fn.signature);
        const signatureHash = canonical
          ? computeSignatureHash(invocationContract, canonical)
          : null;
        await client.query(
          `INSERT INTO function_registry_function_version(
             function_rid, semver, branch, release_version_rid, commit_sha,
             source_path, artifact_sha256, signature, function_kind,
             invocation_contract, signature_hash
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11)
           ON CONFLICT(function_rid, branch, semver) DO NOTHING`,
          [rid, request.semver, request.branch, releaseVersionRid, request.commit_sha, fn.path, artifactSha256, JSON.stringify(fn.signature), fn.functionKind, invocationContract, signatureHash],
        );
        result[fn.apiName] = rid;
      }
      await client.query(
        `UPDATE function_registry_function SET retired_at = now(), updated_at = now()
          WHERE repository_rid = $1 AND retired_at IS NULL
            AND NOT (source_path = ANY($2::text[]))`,
        [request.repository_rid, functions.map((fn) => fn.path)],
      );
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async readTestSources(
    request: PublishRequestRow,
    entries: readonly StemmaTreeEntry[],
  ): Promise<Array<{ path: string; source: string }>> {
    const testPaths = entries
      .filter((entry) => entry.type === "blob" && /\.(test|spec)\.tsx?$/.test(entry.path))
      .map((entry) => entry.path)
      .sort();
    const sources: Array<{ path: string; source: string }> = [];
    for (const path of testPaths) {
      const blob = await this.deps.stemma.readBlob({
        repositoryRid: request.repository_rid,
        branch: request.branch,
        path,
      });
      if (blob.kind !== "ok") throw new Error(`test source unreadable: ${path}`);
      sources.push({ path, source: new TextDecoder().decode(blob.content) });
    }
    return sources;
  }

  private async stageStarted(runRid: string, stage: Stage): Promise<void> {
    const started = await this.deps.pool.query(
      `UPDATE jemma_run_stage s
          SET state = 'RUNNING', started_at = now(), finished_at = NULL, exit_code = NULL,
              log_object_uri = $3
        WHERE s.run_rid = $1 AND s.stage_name = $2
          AND EXISTS (
            SELECT 1 FROM jemma_run r
             WHERE r.rid = s.run_rid AND r.lease_owner = $4 AND r.state = 'RUNNING'
          )`,
      [runRid, stage, `db://jemma/runs/${runRid}/logs?stage=${stage}`, this.owner],
    );
    if (started.rowCount === 0) throw await this.authorityError(runRid);
    await this.logAuthoritative(runRid, stage, "stdout", `> Task :functions-typescript:${stage}`);
  }

  private async stageSucceeded(runRid: string, stage: Stage): Promise<void> {
    const succeeded = await this.deps.pool.query(
      `UPDATE jemma_run_stage s
          SET state = 'SUCCEEDED', finished_at = now(), exit_code = 0
        WHERE s.run_rid = $1 AND s.stage_name = $2 AND s.state = 'RUNNING'
          AND EXISTS (
            SELECT 1 FROM jemma_run r
             WHERE r.rid = s.run_rid AND r.lease_owner = $3 AND r.state = 'RUNNING'
          )`,
      [runRid, stage, this.owner],
    );
    if (succeeded.rowCount === 0) throw await this.authorityError(runRid);
  }

  /**
   * Final deterministic-failure path (also used after retry-budget
   * exhaustion). Every write is authority-guarded and best-effort: a
   * zero-row update means the lease was lost mid-failure, and the new
   * authority's state must not be overwritten.
   */
  private async failRun(runRid: string, stage: Stage, error: unknown): Promise<void> {
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 16_384);
    await this.deps.pool.query(
      `INSERT INTO jemma_run_log(run_rid, stage_name, stream, message)
       SELECT $1, $2, $3, $4
        WHERE EXISTS (
          SELECT 1 FROM jemma_run
           WHERE rid = $1 AND lease_owner = $5 AND state = 'RUNNING'
        )`,
      [runRid, stage, "stderr", message, this.owner],
    );
    await this.deps.pool.query(
      `UPDATE jemma_run_stage s
          SET state = 'FAILED', finished_at = now(), exit_code = 1
        WHERE s.run_rid = $1 AND s.stage_name = $2 AND s.state = 'RUNNING'
          AND EXISTS (
            SELECT 1 FROM jemma_run r
             WHERE r.rid = s.run_rid AND r.lease_owner = $3 AND r.state = 'RUNNING'
          )`,
      [runRid, stage, this.owner],
    );
    await this.deps.pool.query(
      `UPDATE jemma_run_stage s
          SET state = 'SKIPPED', finished_at = now()
        WHERE s.run_rid = $1 AND s.state = 'PENDING'
          AND EXISTS (
            SELECT 1 FROM jemma_run r
             WHERE r.rid = s.run_rid AND r.lease_owner = $2 AND r.state = 'RUNNING'
          )`,
      [runRid, this.owner],
    );
    await this.deps.pool.query(
      `UPDATE jemma_run SET state = 'FAILED', finished_at = now(), exit_code = 1,
              failure_reason = 'stage-failed', lease_owner = NULL, lease_expires_at = NULL,
              resource_version = resource_version + 1, updated_at = now()
        WHERE rid = $1 AND lease_owner = $2 AND state = 'RUNNING'`,
      [runRid, this.owner],
    );
  }

  /**
   * Atomically reserve the next transient retry for THIS owner.
   * Zero rows returned means budget exhausted OR authority lost —
   * distinguished by a follow-up read (the final failure write is
   * itself authority-guarded, so a race here cannot double-write).
   */
  private async reserveRetry(runRid: string): Promise<
    | { kind: "retry"; retryNumber: number; delayMs: number }
    | { kind: "exhausted" }
    | { kind: "authority-lost"; error: RunAuthorityLostError }
  > {
    const reserved = await this.deps.pool.query<{ retry_count: number }>(
      `UPDATE jemma_run
          SET retry_count = retry_count + 1,
              resource_version = resource_version + 1, updated_at = now()
        WHERE rid = $1 AND lease_owner = $2 AND state = 'RUNNING'
          AND retry_count < $3
        RETURNING retry_count`,
      [runRid, this.owner, this.lifecycle.maxTransientRetries],
    );
    const row = reserved.rows[0];
    if (row) {
      return {
        kind: "retry",
        retryNumber: row.retry_count,
        delayMs: computeBackoffMs(row.retry_count, this.lifecycle),
      };
    }
    const state = await this.deps.pool.query<{ state: string; lease_owner: string | null }>(
      `SELECT state, lease_owner FROM jemma_run WHERE rid = $1`,
      [runRid],
    );
    const current = state.rows[0];
    if (current && current.state === "RUNNING" && current.lease_owner === this.owner) {
      return { kind: "exhausted" };
    }
    return { kind: "authority-lost", error: await this.authorityError(runRid) };
  }

  /** Backoff that aborts the moment authority is lost mid-wait. */
  private async waitBackoff(delayMs: number, authority: RunAuthority): Promise<void> {
    await Promise.race([this.lifecycle.sleep(delayMs), authority.lostPromise]);
    authority.throwIfLost();
  }

  /**
   * Lease renewal doubling as the authority assertion. A zero-row
   * update proves the lease is gone (cancelled or reclaimed) — no
   * separate check-then-write race.
   */
  private async assertAuthority(runRid: string): Promise<void> {
    const renewed = await this.deps.pool.query(
      `UPDATE jemma_run
          SET lease_expires_at = now() + ($3::bigint * interval '1 millisecond'),
              updated_at = now()
        WHERE rid = $1 AND lease_owner = $2 AND state = 'RUNNING'`,
      [runRid, this.owner, this.lifecycle.leaseTtlMs],
    );
    if (renewed.rowCount === 0) throw await this.authorityError(runRid);
  }

  private async authorityError(runRid: string): Promise<RunAuthorityLostError> {
    const result = await this.deps.pool.query<{ state: string }>(
      `SELECT state FROM jemma_run WHERE rid = $1`,
      [runRid],
    );
    return new RunAuthorityLostError(result.rows[0]?.state === "CANCELLED" ? "cancelled" : "lease-lost");
  }

  /**
   * Self-scheduling heartbeat (no overlapping renewals: each tick
   * awaits the previous renewal). Runs for the whole execute(),
   * including transient backoff.
   *
   * Safety deadline (monotonic clock): the worker trusts its lease
   * only until `lastConfirmedRenewal + leaseTtl - safetyMargin`.
   * A zero-row renewal loses authority immediately; a transient
   * error keeps beating BUT never extends the deadline — once it
   * passes, authority is lost locally, which aborts stage work,
   * backoff, and any test subprocess before another worker can
   * legally reclaim.
   */
  private startHeartbeat(runRid: string, authority: RunAuthority): { stop: () => Promise<void> } {
    // Clamp the safety margin against the ACTUAL (possibly overridden)
    // lease TTL. resolveLifecycleTunables clamps against the default
    // TTL, so a short test TTL with a default-computed margin would
    // produce a deadline in the past.
    const margin = Math.min(
      this.lifecycle.renewalSafetyMarginMs,
      Math.floor(this.lifecycle.leaseTtlMs / 2),
    );
    const deadline = new AuthorityDeadline(
      this.lifecycle.leaseTtlMs,
      margin,
      this.lifecycle.now,
    );
    // Bind the deadline so every authority.throwIfLost() at external-work
    // boundaries (blob reads, subprocess launch, publish entry, post-subprocess
    // recheck) also evaluates the local lease horizon. A persistent renewal
    // outage must stop ALL work — including non-DB work — before another
    // worker can legally reclaim the lease.
    authority.bindDeadline(deadline);
    let stopped = false;
    const loop = (async () => {
      while (!stopped) {
        // realSleep, not lifecycle.sleep: the injected sleep is for
        // test-controlled backoff only — the heartbeat must tick on a
        // real schedule regardless of test-injected sleep gates.
        await realSleep(this.lifecycle.heartbeatIntervalMs);
        if (stopped) return;
        try {
          const renewed = await this.deps.pool.query(
            `UPDATE jemma_run /* heartbeat */
                SET lease_expires_at = now() + ($3::bigint * interval '1 millisecond'),
                    updated_at = now()
              WHERE rid = $1 AND lease_owner = $2 AND state = 'RUNNING'`,
            [runRid, this.owner, this.lifecycle.leaseTtlMs],
          );
          if (renewed.rowCount === 0) {
            this.loseAuthority(runRid, authority, (await this.authorityError(runRid)).reason);
            return;
          }
          deadline.confirmRenewal();
        } catch (error) {
          if (classifyError(error) !== "transient" || deadline.expired()) {
            this.loseAuthority(runRid, authority, "lease-lost");
            return;
          }
        }
      }
    })();
    return {
      stop: async () => {
        stopped = true;
        await loop.catch(() => undefined);
      },
    };
  }

  private loseAuthority(
    runRid: string,
    authority: RunAuthority,
    reason: "lease-lost" | "cancelled" | "shutdown",
  ): void {
    authority.lose(reason);
    this.lifecycle.onAuthorityLost?.(runRid, reason);
  }

  private async log(runRid: string, stage: Stage | null, stream: "stdout" | "stderr" | "system", message: string): Promise<void> {
    await this.deps.pool.query(
      `INSERT INTO jemma_run_log(run_rid, stage_name, stream, message) VALUES ($1,$2,$3,$4)`,
      [runRid, stage, stream, message.slice(0, 16_384)],
    );
  }

  /**
   * Log write that proves ownership in the same statement — a worker
   * that lost the lease cannot append to the reclaimer's timeline;
   * the zero-row insert stops it via RunAuthorityLostError.
   */
  private async logAuthoritative(runRid: string, stage: Stage | null, stream: "stdout" | "stderr" | "system", message: string): Promise<void> {
    const written = await this.deps.pool.query(
      `INSERT INTO jemma_run_log(run_rid, stage_name, stream, message)
       SELECT $1, $2, $3, $4
        WHERE EXISTS (
          SELECT 1 FROM jemma_run
           WHERE rid = $1 AND lease_owner = $5 AND state = 'RUNNING'
        )`,
      [runRid, stage, stream, message.slice(0, 16_384), this.owner],
    );
    if (written.rowCount === 0) throw await this.authorityError(runRid);
  }
}

function isTerminalRunState(state: string): boolean {
  return state === "SUCCEEDED" || state === "FAILED" || state === "CANCELLED" || state === "TIMED_OUT";
}

export function retryEligibility(
  runRid: string,
  attemptedSemver: string,
  availableVersions: readonly string[],
): RetryEligibility {
  const latestSemver = availableVersions.reduce<string | null>((latest, candidate) => {
    parseSemver(candidate);
    return latest === null
      || compareSemver(parseSemver(candidate), parseSemver(latest)) > 0
      ? candidate
      : latest;
  }, null);
  const retryable = latestSemver === null
    || compareSemver(parseSemver(attemptedSemver), parseSemver(latestSemver)) >= 0;
  return {
    runRid,
    retryable,
    reason: retryable ? null : "VERSION_OUTDATED",
    attemptedSemver,
    latestSemver,
    suggestedSemver: retryable || latestSemver === null
      ? null
      : nextReleaseSemver(latestSemver),
  };
}

function nextReleaseSemver(latestSemver: string): string {
  const parsed = parseSemver(latestSemver);
  return parsed.preRelease.length > 0
    ? `${parsed.major}.${parsed.minor}.${parsed.patch}`
    : `${parsed.major}.${parsed.minor}.${parsed.patch + 1}`;
}

function isPgUniqueViolation(error: unknown, constraint: string): boolean {
  if (typeof error !== "object" || error === null) return false;
  const pg = error as { code?: unknown; constraint?: unknown };
  return pg.code === "23505" && pg.constraint === constraint;
}

export function discoverTypeScriptV2FunctionPaths(entries: Array<{ path: string; type: string }>): string[] {
  return entries
    .filter((entry) => entry.type === "blob")
    .map((entry) => entry.path)
    .filter((path) => /(^|\/)typescript-functions\/src\/functions\/.+\.ts$/.test(path)
      || /(^|\/)src\/functions\/.+\.ts$/.test(path))
    .filter((path) => !/\.(test|spec)\.ts$/.test(path) && !path.endsWith(".d.ts"))
    .sort();
}

function fileStem(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1, -3);
}

export function inspectTypeScriptV2Function(path: string, source: string): FunctionSignature {
  return inspectPublishedFunction(path, source).signature;
}

/**
 * The single publish-time source analysis: extracts the declared
 * signature AND the declared function kind (edit contract) from one
 * AST walk. A malformed/contradictory edit declaration throws
 * FunctionsPublishError INVALID_FUNCTION — the release FAILS rather
 * than publishing incorrect registry metadata.
 */
export function inspectPublishedFunction(path: string, source: string): PublishedFunctionMetadata {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const declaration = file.statements.find((statement): statement is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(statement)
    && Boolean(statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword))
    && Boolean(statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)),
  );
  if (!declaration) {
    throw new FunctionsPublishError("INVALID_FUNCTION", `${path} must default-export a function declaration`);
  }
  const expectedName = fileStem(path);
  if (declaration.name?.text !== expectedName) {
    throw new FunctionsPublishError("INVALID_FUNCTION", `${path} must export a function named ${expectedName}`);
  }
  if (!declaration.type || declaration.parameters.some((parameter) => !parameter.type)) {
    throw new FunctionsPublishError("INVALID_FUNCTION", `${path} must explicitly type every input and its return value`);
  }
  let functionKind: FunctionKind;
  try {
    functionKind = classifyFunctionKind(file, declaration, path);
  } catch (error) {
    if (error instanceof InvalidEditDeclarationError) {
      throw new FunctionsPublishError("INVALID_FUNCTION", error.message);
    }
    throw error;
  }
  return {
    signature: {
      parameters: declaration.parameters.map((parameter, position) => ({
        name: parameter.name.getText(file),
        type: parameter.type!.getText(file),
        optional: Boolean(parameter.questionToken || parameter.initializer),
        position,
        hasDefault: Boolean(parameter.initializer),
        typeModel: canonicalTypeOfParameter(parameter.type),
      })),
      output: declaration.type.getText(file),
    },
    functionKind,
  };
}

async function validateCompatibility(
  pool: Pool,
  repositoryRid: string,
  branch: string,
  semver: string,
  functions: FunctionSource[],
): Promise<void> {
  const versions = await listVersions(pool, repositoryRid, { branch, includeYanked: false });
  const latest = versions.reduce<(typeof versions)[number] | null>((winner, candidate) =>
    !winner || compareSemver(parseSemver(candidate.semver), parseSemver(winner.semver)) > 0 ? candidate : winner, null);
  if (!latest) return;
  if (compareSemver(parseSemver(semver), parseSemver(latest.semver)) < 0) {
    throw new FunctionsPublishError("VERSION_CONFLICT", `Version must not be lower than ${latest.semver}`);
  }
  const oldExports = Array.isArray((latest.manifest as { exports?: unknown }).exports)
    ? (latest.manifest as { exports: unknown[] }).exports.filter((value): value is string => typeof value === "string")
    : [];
  const current = new Map(functions.map((fn) => [fn.apiName, fn.signature]));
  const breaking: string[] = oldExports.filter((name) => !current.has(name)).map((name) => `dropped function ${name}`);
  const priorSignatures = (latest.manifest as { signatures?: Record<string, FunctionSignature> }).signatures ?? {};
  for (const [name, oldSignature] of Object.entries(priorSignatures)) {
    const next = current.get(name);
    if (!next) continue;
    // Structural comparison (Track 2 #6): formatting-only type
    // differences (whitespace, parens, comments, union order) are
    // compatible; semantic changes follow the documented variance
    // rules in signatureCompat.ts. Existing manifests carry textual
    // signatures, which this comparison consumes unchanged — no
    // republication of historical artifacts is required.
    for (const line of compareSignaturesStructural(oldSignature, next)) {
      breaking.push(`${name}: ${line}`);
    }
  }
  const majorBump = parseSemver(semver).major > parseSemver(latest.semver).major;
  if (breaking.length && !majorBump && parseSemver(semver).major !== 0) {
    throw new FunctionsPublishError("VERSION_CONFLICT", "Backward-incompatible changes require a major release", { breaking });
  }
}
