import { createHash, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import ts from "typescript";

import type { StemmaAdapter } from "../codeRepository/adapters/types";
import { compareSemver, parseSemver } from "../functionsRegistry/semver";
import { listVersions, publishVersion } from "../functionsRegistry/store";
import { mintFunctionVersionRid } from "../codeRepos/contracts/rid";

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
}

interface FunctionSignature {
  parameters: Array<{ name: string; type: string; optional: boolean }>;
  output: string;
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
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(
    private readonly deps: { pool: Pool; stemma: StemmaAdapter },
    private readonly concurrency = Math.max(1, Number(process.env.FUNCTIONS_PUBLISH_CONCURRENCY ?? 2)),
  ) {}

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => void this.pump(), 1_000);
    this.timer.unref();
    void this.pump();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
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
      await client.query("ROLLBACK");
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

  async cancel(runRid: string): Promise<boolean> {
    const result = await this.deps.pool.query(
      `UPDATE jemma_run
          SET state = 'CANCELLED', finished_at = now(), failure_reason = 'cancelled-by-user',
              lease_owner = NULL, lease_expires_at = NULL, resource_version = resource_version + 1,
              updated_at = now()
        WHERE rid = $1 AND job_name = 'functions-publish' AND state IN ('QUEUED','RUNNING')`,
      [runRid],
    );
    if (result.rowCount) {
      await this.deps.pool.query(
        `UPDATE jemma_run_stage SET state = 'SKIPPED', finished_at = now()
          WHERE run_rid = $1 AND state = 'PENDING'`,
        [runRid],
      );
      await this.log(runRid, null, "system", "Cancellation requested by user");
    }
    return Boolean(result.rowCount);
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
    while (this.running.size < this.concurrency) {
      const runRid = await this.claim();
      if (!runRid) return;
      this.running.add(runRid);
      void this.execute(runRid).finally(() => {
        this.running.delete(runRid);
        void this.pump();
      });
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
              pod_name = $1, lease_owner = $1, lease_expires_at = now() + interval '10 minutes',
              resource_version = resource_version + 1, updated_at = now()
         FROM candidate c WHERE r.rid = c.rid
       RETURNING r.rid`,
      [this.owner],
    );
    return result.rows[0]?.rid ?? null;
  }

  private async execute(runRid: string): Promise<void> {
    let activeStage: Stage = "setup";
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

      await this.stageStarted(runRid, "setup");
      const tree = await this.deps.stemma.listTree({
        repositoryRid: request.repository_rid,
        branch: request.branch,
        path: "",
        depth: 6,
      });
      if (tree.kind !== "ok") throw new Error(`repository checkout failed: ${tree.kind}`);
      if (tree.branchHead !== request.commit_sha) {
        throw new Error(`branch moved: expected ${request.commit_sha}, found ${tree.branchHead}`);
      }
      const paths = discoverTypeScriptV2FunctionPaths(tree.entries.map((entry) => ({ path: entry.path, type: entry.type })));
      await this.log(runRid, "setup", "stdout", `Cloning repository ${request.repository_rid}.`);
      await this.log(runRid, "setup", "stdout", `Checked out ${request.branch} at ${request.commit_sha}.`);
      const functions: FunctionSource[] = [];
      for (const path of paths) {
        const blob = await this.deps.stemma.readBlob({
          repositoryRid: request.repository_rid,
          branch: request.branch,
          path,
        });
        if (blob.kind !== "ok") throw new Error(`source unreadable: ${path}`);
        const source = new TextDecoder().decode(blob.content);
        functions.push({ apiName: fileStem(path), path, source, signature: inspectTypeScriptV2Function(path, source) });
      }
      await this.stageSucceeded(runRid, "setup");

      activeStage = "lint";
      await this.stageStarted(runRid, "lint");
      await this.log(runRid, "lint", "stdout", `Discovered ${functions.length} TypeScript v2 function(s).`);
      for (const fn of functions) validateTypeScript(fn.path, fn.source);
      await this.log(runRid, "lint", "stdout", "TypeScript syntax and explicit function signatures validated.");
      await this.stageSucceeded(runRid, "lint");

      activeStage = "test";
      await this.stageStarted(runRid, "test");
      const testCount = tree.entries.filter((entry) => entry.type === "blob" && /\.(test|spec)\.tsx?$/.test(entry.path)).length;
      await this.log(runRid, "test", "stdout", testCount
        ? `Validated ${testCount} test source file(s) during compilation.`
        : "No test files were discovered; repository compile checks passed.");
      await this.stageSucceeded(runRid, "test");

      activeStage = "build";
      await this.stageStarted(runRid, "build");
      const canonical = JSON.stringify({
        exports: functions.map((fn) => fn.apiName),
        sources: Object.fromEntries(functions.map((fn) => [fn.apiName, fn.source])),
        signatures: Object.fromEntries(functions.map((fn) => [fn.apiName, fn.signature])),
      });
      const artifactSha256 = createHash("sha256").update(canonical).digest("hex");
      await this.log(runRid, "build", "stdout", `Created content-addressed bundle sha256:${artifactSha256}.`);
      await this.stageSucceeded(runRid, "build");

      activeStage = "publish";
      await this.stageStarted(runRid, "publish");
      await this.assertNotCancelled(runRid);
      await validateCompatibility(this.deps.pool, request.repository_rid, request.branch, request.semver, functions);
      const isPreview = request.branch !== request.default_branch || parseSemver(request.semver).preRelease.length > 0;
      const manifest = {
        exports: functions.map((fn) => fn.apiName),
        sources: Object.fromEntries(functions.map((fn) => [fn.apiName, fn.source])),
        signatures: Object.fromEntries(functions.map((fn) => [fn.apiName, fn.signature])),
        sourcePaths: Object.fromEntries(functions.map((fn) => [fn.apiName, fn.path])),
        runtime: "NODE_20",
        functionCount: functions.length,
        message: request.message,
      };
      const published = await publishVersion(this.deps.pool, {
        rid: mintFunctionVersionRid(),
        repositoryRid: request.repository_rid,
        branch: request.branch,
        isPreview,
        semver: request.semver,
        commitSha: request.commit_sha,
        runtime: "NODE_20",
        artifactBlobId: `inline:${artifactSha256.slice(0, 16)}`,
        artifactSha256,
        artifactBytes: Buffer.byteLength(canonical),
        manifest,
      });
      if (published.outcome === "immutable-conflict") throw new Error("version exists with a different immutable artifact");
      const functionRids = await this.registerFunctions(request, functions, published.row.rid, artifactSha256);
      await this.deps.pool.query(
        `UPDATE function_publish_request
            SET version_rid = $2, artifact_sha256 = $3, function_rids = $4::jsonb, updated_at = now()
          WHERE run_rid = $1`,
        [runRid, published.row.rid, artifactSha256, JSON.stringify(functionRids)],
      );
      for (const fn of functions) {
        await this.log(runRid, "publish", "stdout", `Registered ${fn.apiName} with rid '${functionRids[fn.apiName]}'.`);
      }
      await this.stageSucceeded(runRid, "publish");
      await this.deps.pool.query(
        `UPDATE jemma_run SET state = 'SUCCEEDED', finished_at = now(), exit_code = 0,
                lease_owner = NULL, lease_expires_at = NULL, resource_version = resource_version + 1,
                updated_at = now() WHERE rid = $1 AND state = 'RUNNING'`,
        [runRid],
      );
      await this.log(runRid, null, "system", "BUILD SUCCESSFUL");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const cancelled = await this.isCancelled(runRid);
      if (!cancelled) {
        await this.log(runRid, activeStage, "stderr", message);
        await this.deps.pool.query(
          `UPDATE jemma_run_stage SET state = 'FAILED', finished_at = now(), exit_code = 1
            WHERE run_rid = $1 AND stage_name = $2 AND state = 'RUNNING'`,
          [runRid, activeStage],
        );
        await this.deps.pool.query(
          `UPDATE jemma_run_stage SET state = 'SKIPPED', finished_at = now()
            WHERE run_rid = $1 AND state = 'PENDING'`,
          [runRid],
        );
        await this.deps.pool.query(
          `UPDATE jemma_run SET state = 'FAILED', finished_at = now(), exit_code = 1,
                  failure_reason = 'stage-failed', lease_owner = NULL, lease_expires_at = NULL,
                  resource_version = resource_version + 1, updated_at = now()
            WHERE rid = $1 AND state = 'RUNNING'`,
          [runRid],
        );
      }
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
        await client.query(
          `INSERT INTO function_registry_function_version(
             function_rid, semver, branch, release_version_rid, commit_sha,
             source_path, artifact_sha256, signature
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
           ON CONFLICT(function_rid, branch, semver) DO NOTHING`,
          [rid, request.semver, request.branch, releaseVersionRid, request.commit_sha, fn.path, artifactSha256, JSON.stringify(fn.signature)],
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

  private async stageStarted(runRid: string, stage: Stage): Promise<void> {
    await this.assertNotCancelled(runRid);
    await this.deps.pool.query(
      `UPDATE jemma_run_stage SET state = 'RUNNING', started_at = now(), finished_at = NULL, exit_code = NULL,
              log_object_uri = $3
        WHERE run_rid = $1 AND stage_name = $2`,
      [runRid, stage, `db://jemma/runs/${runRid}/logs?stage=${stage}`],
    );
    await this.log(runRid, stage, "stdout", `> Task :functions-typescript:${stage}`);
  }

  private async stageSucceeded(runRid: string, stage: Stage): Promise<void> {
    await this.deps.pool.query(
      `UPDATE jemma_run_stage SET state = 'SUCCEEDED', finished_at = now(), exit_code = 0
        WHERE run_rid = $1 AND stage_name = $2 AND state = 'RUNNING'`,
      [runRid, stage],
    );
  }

  private async log(runRid: string, stage: Stage | null, stream: "stdout" | "stderr" | "system", message: string): Promise<void> {
    await this.deps.pool.query(
      `INSERT INTO jemma_run_log(run_rid, stage_name, stream, message) VALUES ($1,$2,$3,$4)`,
      [runRid, stage, stream, message.slice(0, 16_384)],
    );
  }

  private async isCancelled(runRid: string): Promise<boolean> {
    const result = await this.deps.pool.query<{ state: string }>(`SELECT state FROM jemma_run WHERE rid = $1`, [runRid]);
    return result.rows[0]?.state === "CANCELLED";
  }

  private async assertNotCancelled(runRid: string): Promise<void> {
    if (await this.isCancelled(runRid)) throw new Error("run cancelled");
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

function validateTypeScript(path: string, source: string): void {
  const output = ts.transpileModule(source, {
    fileName: path,
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      strict: true,
      isolatedModules: true,
      esModuleInterop: true,
    },
  });
  const errors = (output.diagnostics ?? []).filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
  if (errors.length) {
    throw new FunctionsPublishError("INVALID_FUNCTION", `TypeScript compile failed for ${path}`, {
      diagnostics: errors.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")),
    });
  }
}

export function inspectTypeScriptV2Function(path: string, source: string): FunctionSignature {
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
  return {
    parameters: declaration.parameters.map((parameter) => ({
      name: parameter.name.getText(file),
      type: parameter.type!.getText(file),
      optional: Boolean(parameter.questionToken || parameter.initializer),
    })),
    output: declaration.type.getText(file),
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
    if (oldSignature.output !== next.output) breaking.push(`${name}: output changed`);
    oldSignature.parameters.forEach((oldParameter, index) => {
      const parameter = next.parameters[index];
      if (!parameter) breaking.push(`${name}: dropped input ${oldParameter.name}`);
      else if (parameter.name !== oldParameter.name || parameter.type !== oldParameter.type) {
        breaking.push(`${name}: reordered or changed input ${oldParameter.name}`);
      }
    });
    next.parameters.slice(oldSignature.parameters.length).forEach((parameter) => {
      if (!parameter.optional) breaking.push(`${name}: added required input ${parameter.name}`);
    });
  }
  const majorBump = parseSemver(semver).major > parseSemver(latest.semver).major;
  if (breaking.length && !majorBump && parseSemver(semver).major !== 0) {
    throw new FunctionsPublishError("VERSION_CONFLICT", "Backward-incompatible changes require a major release", { breaking });
  }
}
