// ---------------------------------------------------------------------------
// functions-publish service integration tests (Track 1 hardening).
//
// Drives FunctionsPublishService against schema-isolated Postgres with a
// fake StemmaAdapter, so the full enqueue → claim → stage chain → publish
// path runs for real (including jemma_run_log assertions).
//
// ISOLATION CONTRACT (2026-07-28 rewrite):
//
//   * EVERY test gets a FRESH schema (beforeEach/afterEach, not
//     beforeAll/afterAll). The claim query picks the globally oldest
//     QUEUED/reclaimable run (ORDER BY queued_at ASC FOR UPDATE SKIP
//     LOCKED), so a run left QUEUED or RUNNING by an earlier test is
//     claimed by a later test's service — starving that test's own run
//     behind a single concurrency slot. A fresh schema per test makes
//     leftover runs physically impossible.
//   * EVERY constructed service is registered via trackService() and
//     drained (await stop()) in afterEach — including mid-test failure
//     paths — so pumps, heartbeats, and backoff loops never survive
//     into the next test.
//   * Every test is fully self-contained: any registry state it
//     depends on (e.g. a previously published 1.0.0) is created inside
//     the test itself. Tests are order-independent.
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import type { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FunctionsPublishService } from "../../../../src/services/functionsPublish/service";
import type {
  StemmaAdapter,
  StemmaListTreeArgs,
  StemmaListTreeOutcome,
  StemmaReadBlobArgs,
  StemmaReadBlobOutcome,
  StemmaTreeEntry,
} from "../../../../src/services/codeRepository/adapters/types";
import { openTestSchema, type SchemaContext } from "../_helpers/pg";

// Real MinIO from docker-compose — credentials from the repo
// .env (same source the backend uses); compose defaults are
// the fallback. The publish path stores real artifact blobs
// (Track 2 #8); never fabricated in production code.
import "dotenv/config";
process.env.S3_ENDPOINT ??= "http://localhost:9000";
process.env.S3_BUCKET ??= "tellus-uploads";
process.env.S3_ACCESS_KEY_ID ??= "minioadmin";
process.env.S3_SECRET_ACCESS_KEY ??= "minioadmin";

const BRANCH_HEAD = "abcdef0123456789";
const REPO_RID = "ri.stemma.main.repository.00000000-0000-0000-0000-0000000000aa";

async function applyPublishMigrations(ctx: SchemaContext): Promise<void> {
  await ctx.applyMigration("src/migrations/054_b6_jemma.sql");
  await ctx.applyMigration("src/migrations/055_b8_functions_registry.sql");
  await ctx.applyMigration("src/migrations/116_functions_publish_jobs.sql");
  await ctx.applyMigration("src/migrations/118_functions_publish_retrigger.sql");
  await ctx.applyMigration("src/migrations/137_functions_publish_retry.sql");
  // 139 adds function_registry_function_version.function_kind, which
  // registerFunctions now writes (functionKind classification).
  await ctx.applyMigration("src/migrations/139_function_kind.sql");
    await ctx.applyMigration("src/migrations/143_automate.sql");
await ctx.applyMigration("src/migrations/156_function_invocation_contract.sql");
}

// ---------------------------------------------------------------------------
// Service registry: every FunctionsPublishService a test constructs is
// drained (await stop()) in afterEach, even when the test fails mid-way.
// stop() is idempotent, so tests whose act IS stop() can also call it.
// ---------------------------------------------------------------------------
let trackedServices: FunctionsPublishService[] = [];

function trackService<T extends FunctionsPublishService>(service: T): T {
  trackedServices.push(service);
  return service;
}

async function stopTrackedServices(): Promise<void> {
  const services = trackedServices.splice(0);
  for (const service of services) await service.stop();
}

/** Minimal Stemma double: serves listTree/readBlob from a mutable file map. */
class FakeStemma implements StemmaAdapter {
  readonly files = new Map<string, string>();

  async listTree(args: StemmaListTreeArgs): Promise<StemmaListTreeOutcome> {
    void args;
    const entries: StemmaTreeEntry[] = [...this.files.keys()].sort().map((path) => ({
      name: path.slice(path.lastIndexOf("/") + 1),
      path,
      type: "blob" as const,
      mode: "100644",
      sha: BRANCH_HEAD,
    }));
    return { kind: "ok", entries, truncated: false, branchHead: BRANCH_HEAD, treeSha: BRANCH_HEAD };
  }

  async readBlob(args: StemmaReadBlobArgs): Promise<StemmaReadBlobOutcome> {
    const source = this.files.get(args.path);
    if (source === undefined) return { kind: "path-not-found" };
    const content = new TextEncoder().encode(source);
    return { kind: "ok", content, sha: BRANCH_HEAD, size: content.byteLength };
  }

  async createRepository(): Promise<never> {
    throw new Error("not used by functions-publish");
  }
  async tombstone(): Promise<void> {
    throw new Error("not used by functions-publish");
  }
  async commitFiles(): Promise<never> {
    throw new Error("not used by functions-publish");
  }
  async createBranch(): Promise<never> {
    throw new Error("not used by functions-publish");
  }
  async deleteBranch(): Promise<never> {
    throw new Error("not used by functions-publish");
  }
  async listBranches(): Promise<never> {
    throw new Error("not used by functions-publish");
  }
}

async function waitForTerminal(pool: Pool, rid: string, timeoutMs = 20_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await pool.query<{ state: string }>(`SELECT state FROM jemma_run WHERE rid = $1`, [rid]);
    const state = result.rows[0]?.state;
    if (state === "SUCCEEDED" || state === "FAILED" || state === "CANCELLED" || state === "TIMED_OUT") {
      return state;
    }
    if (Date.now() > deadline) throw new Error(`run ${rid} did not reach a terminal state in ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

function functionSource(name: string): string {
  return `export default function ${name}(input: string): string { return input; }\n`;
}

describe("functions-publish service (integration)", () => {
  let ctx: SchemaContext;
  let stemma: FakeStemma;
  let service: FunctionsPublishService;

  beforeEach(async () => {
    ctx = await openTestSchema("functions_publish_svc");
    await applyPublishMigrations(ctx);
    stemma = new FakeStemma();
    service = trackService(new FunctionsPublishService({ pool: ctx.pool, stemma }));
  });

  afterEach(async () => {
    await stopTrackedServices();
    await ctx.close();
  });

  it("publishes a release end-to-end (baseline for the compat-failure case)", async () => {
    stemma.files.set("typescript-functions/src/functions/alpha.ts", functionSource("alpha"));
    stemma.files.set("typescript-functions/src/functions/beta.ts", functionSource("beta"));

    const enqueued = await service.enqueue({
      repositoryRid: REPO_RID,
      branch: "main",
      defaultBranch: "main",
      semver: "1.0.0",
      message: "initial release",
      triggeredBy: randomUUID(),
      idempotencyKey: randomUUID(),
    });
    expect(enqueued.replayed).toBe(false);

    expect(await waitForTerminal(ctx.pool, enqueued.runRid)).toBe("SUCCEEDED");
    const versions = await ctx.query(`SELECT semver, state FROM function_version WHERE repository_rid = $1`, [REPO_RID]);
    expect(versions.rows).toEqual([{ semver: "1.0.0", state: "AVAILABLE" }]);

    // Zero-test policy: no discovered tests is a pass, with the legacy log line.
    const logs = await ctx.query<{ message: string }>(
      `SELECT message FROM jemma_run_log WHERE run_rid = $1 AND stage_name = 'test'`,
      [enqueued.runRid],
    );
    expect(logs.rows.some((row) => row.message.includes("No test files were discovered"))).toBe(true);
  });

  it("logs the full breaking-change list when the compat check fails", async () => {
    // Self-contained: publish 1.0.0 (alpha+beta) first — per-test
    // schemas mean nothing carries over from the previous test.
    stemma.files.set("typescript-functions/src/functions/alpha.ts", functionSource("alpha"));
    stemma.files.set("typescript-functions/src/functions/beta.ts", functionSource("beta"));
    const first = await service.enqueue({
      repositoryRid: REPO_RID,
      branch: "main",
      defaultBranch: "main",
      semver: "1.0.0",
      message: "initial release",
      triggeredBy: randomUUID(),
      idempotencyKey: randomUUID(),
    });
    expect(await waitForTerminal(ctx.pool, first.runRid)).toBe("SUCCEEDED");

    // Drop `beta` and tag a non-major release → deterministic VERSION_CONFLICT.
    stemma.files.delete("typescript-functions/src/functions/beta.ts");

    const enqueued = await service.enqueue({
      repositoryRid: REPO_RID,
      branch: "main",
      defaultBranch: "main",
      semver: "1.0.1",
      message: "drop beta without a major bump",
      triggeredBy: randomUUID(),
      idempotencyKey: randomUUID(),
    });

    expect(await waitForTerminal(ctx.pool, enqueued.runRid)).toBe("FAILED");

    const logs = await ctx.query<{ stage_name: string | null; stream: string; message: string }>(
      `SELECT stage_name, stream, message FROM jemma_run_log WHERE run_rid = $1 ORDER BY id`,
      [enqueued.runRid],
    );
    const publishStderr = logs.rows.filter((row) => row.stage_name === "publish" && row.stream === "stderr");

    // Top-line message (pre-existing behavior) …
    expect(publishStderr.some((row) => row.message.includes("Backward-incompatible changes require a major release"))).toBe(true);
    // … and the full breaking-change detail array (Track 1 item 5).
    expect(publishStderr.some((row) => row.message.includes("dropped function beta"))).toBe(true);

    // The version must be burned: no 1.0.1 row may exist in the registry.
    const versions = await ctx.query(`SELECT semver FROM function_version WHERE repository_rid = $1 AND semver = '1.0.1'`, [REPO_RID]);
    expect(versions.rowCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Track 1 items #1 (real test execution) and #2 (real lint/type-check).
// ---------------------------------------------------------------------------

interface RunOutcome {
  readonly runRid: string;
  readonly repoRid: string;
  readonly state: string;
}

async function runPublish(
  ctx: SchemaContext,
  stemma: FakeStemma,
  tunables: ConstructorParameters<typeof FunctionsPublishService>[2] = {},
  lifecycle: ConstructorParameters<typeof FunctionsPublishService>[3] = {},
  pool: Pool = ctx.pool,
): Promise<RunOutcome> {
  const repoRid = `ri.stemma.main.repository.00000000-0000-0000-0000-${randomUUID().slice(0, 12)}`;
  const service = trackService(new FunctionsPublishService({ pool, stemma }, 1, tunables, lifecycle));
  const enqueued = await service.enqueue({
    repositoryRid: repoRid,
    branch: "main",
    defaultBranch: "main",
    semver: "1.0.0",
    message: null,
    triggeredBy: randomUUID(),
    idempotencyKey: randomUUID(),
  });
  return { runRid: enqueued.runRid, repoRid, state: await waitForTerminal(pool, enqueued.runRid) };
}

async function stageStates(
  ctx: SchemaContext,
  runRid: string,
): Promise<Record<string, string>> {
  const result = await ctx.query<{ stage_name: string; state: string }>(
    `SELECT stage_name, state FROM jemma_run_stage WHERE run_rid = $1`,
    [runRid],
  );
  return Object.fromEntries(result.rows.map((row) => [row.stage_name, row.state]));
}

async function logMessages(
  ctx: SchemaContext,
  runRid: string,
  stage: string,
): Promise<string[]> {
  const result = await ctx.query<{ message: string }>(
    `SELECT message FROM jemma_run_log WHERE run_rid = $1 AND stage_name = $2 ORDER BY id`,
    [runRid, stage],
  );
  return result.rows.map((row) => row.message);
}

describe("functions-publish lint stage — real type-checking (item #2)", () => {
  let ctx: SchemaContext;
  let stemma: FakeStemma;

  beforeEach(async () => {
    ctx = await openTestSchema("functions_publish_lint");
    await applyPublishMigrations(ctx);
    stemma = new FakeStemma();
  });

  afterEach(async () => {
    await stopTrackedServices();
    await ctx.close();
  });

  it("passes a valid multi-file repository (relative import resolves)", async () => {
    stemma.files.set("typescript-functions/src/functions/beta.ts",
      "export function double(n: number): number { return n * 2; }\nexport default function beta(input: string): string { return input; }\n");
    stemma.files.set("typescript-functions/src/functions/alpha.ts",
      "import { double } from \"./beta\";\nexport default function alpha(input: string): string { return String(double(input.length)); }\n");
    const outcome = await runPublish(ctx, stemma);
    expect(outcome.state).toBe("SUCCEEDED");
    expect(await stageStates(ctx, outcome.runRid)).toMatchObject({
      setup: "SUCCEEDED", lint: "SUCCEEDED", test: "SUCCEEDED", build: "SUCCEEDED", publish: "SUCCEEDED",
    });
  });

  it("fails lint on a syntax error; publish stage is never reached", async () => {
    stemma.files.set("typescript-functions/src/functions/alpha.ts",
      "export default function alpha(input: string): string { return input; \n");
    const outcome = await runPublish(ctx, stemma);
    expect(outcome.state).toBe("FAILED");
    expect(await stageStates(ctx, outcome.runRid)).toMatchObject({
      setup: "SUCCEEDED", lint: "FAILED", test: "SKIPPED", build: "SKIPPED", publish: "SKIPPED",
    });
    const lintLog = (await logMessages(ctx, outcome.runRid, "lint")).join("\n");
    expect(lintLog).toMatch(/error TS1\d{3}/);
    const versions = await ctx.query(
      `SELECT COUNT(*)::int AS n FROM function_version fv
        JOIN jemma_run r ON r.rid = $1 AND fv.repository_rid = r.repository_rid`,
      [outcome.runRid],
    );
    expect(versions.rows[0].n).toBe(0);
  });

  it("fails lint on a semantic type mismatch (TS2322)", async () => {
    stemma.files.set("typescript-functions/src/functions/alpha.ts",
      "export default function alpha(input: string): string { const n: number = \"x\"; return String(n); }\n");
    const outcome = await runPublish(ctx, stemma);
    expect(outcome.state).toBe("FAILED");
    expect((await logMessages(ctx, outcome.runRid, "lint")).join("\n")).toContain("error TS2322");
  });

  it("fails lint on a nonsense package import", async () => {
    stemma.files.set("typescript-functions/src/functions/alpha.ts",
      "import { wat } from \"totally-made-up\";\nexport default function alpha(input: string): string { return String(wat) + input; }\n");
    const outcome = await runPublish(ctx, stemma);
    expect(outcome.state).toBe("FAILED");
    expect((await stageStates(ctx, outcome.runRid)).lint).toBe("FAILED");
    expect((await logMessages(ctx, outcome.runRid, "lint")).join("\n")).toContain("totally-made-up");
  });

  it("fails lint on a missing relative import (TS2307)", async () => {
    stemma.files.set("typescript-functions/src/functions/alpha.ts",
      "import { missing } from \"./missing\";\nexport default function alpha(input: string): string { return String(missing) + input; }\n");
    const outcome = await runPublish(ctx, stemma);
    expect(outcome.state).toBe("FAILED");
    expect((await logMessages(ctx, outcome.runRid, "lint")).join("\n")).toContain("error TS2307");
  });

  it("fails lint on a cross-file type error (TS2345)", async () => {
    stemma.files.set("typescript-functions/src/functions/beta.ts",
      "export function double(n: number): number { return n * 2; }\nexport default function beta(input: string): string { return input; }\n");
    stemma.files.set("typescript-functions/src/functions/alpha.ts",
      "import { double } from \"./beta\";\nexport default function alpha(input: string): string { return String(double(\"not-a-number\")); }\n");
    const outcome = await runPublish(ctx, stemma);
    expect(outcome.state).toBe("FAILED");
    expect((await logMessages(ctx, outcome.runRid, "lint")).join("\n")).toContain("error TS2345");
  });
});

describe("functions-publish test stage — real test execution (item #1)", () => {
  let ctx: SchemaContext;
  let stemma: FakeStemma;

  beforeEach(async () => {
    ctx = await openTestSchema("functions_publish_test");
    await applyPublishMigrations(ctx);
    stemma = new FakeStemma();
  });

  afterEach(async () => {
    await stopTrackedServices();
    await ctx.close();
  });

  it("runs a passing test to SUCCEEDED and publishes the version", async () => {
    stemma.files.set("typescript-functions/src/functions/alpha.ts", functionSource("alpha"));
    stemma.files.set("typescript-functions/src/functions/alpha.test.ts", `
import { test } from "node:test";
import assert from "node:assert";
import alpha from "./alpha";
test("alpha echoes", () => { assert.strictEqual(alpha("x"), "x"); });
`);
    const outcome = await runPublish(ctx, stemma);
    expect(outcome.state).toBe("SUCCEEDED");
    expect((await stageStates(ctx, outcome.runRid)).test).toBe("SUCCEEDED");
    const testLog = (await logMessages(ctx, outcome.runRid, "test")).join("\n");
    expect(testLog).toMatch(/Executed 1 test\(s\) across 1 test file\(s\).*: 1 passed/);
    const versions = await ctx.query(
      `SELECT fv.semver, fv.state FROM function_version fv
        JOIN jemma_run r ON r.rid = $1 AND fv.repository_rid = r.repository_rid`,
      [outcome.runRid],
    );
    expect(versions.rows).toEqual([{ semver: "1.0.0", state: "AVAILABLE" }]);
  });

  it("fails the run on a failing assertion, with counts and details in the log", async () => {
    stemma.files.set("typescript-functions/src/functions/alpha.ts", functionSource("alpha"));
    stemma.files.set("typescript-functions/src/functions/alpha.test.ts", `
import { test } from "node:test";
import assert from "node:assert";
import alpha from "./alpha";
test("first passes", () => { assert.strictEqual(alpha("x"), "x"); });
test("second fails", () => { assert.strictEqual(alpha("x"), "y"); });
test("third passes", () => { assert.strictEqual(alpha("z"), "z"); });
`);
    const outcome = await runPublish(ctx, stemma);
    expect(outcome.state).toBe("FAILED");
    expect(await stageStates(ctx, outcome.runRid)).toMatchObject({
      lint: "SUCCEEDED", test: "FAILED", build: "SKIPPED", publish: "SKIPPED",
    });
    const testLog = (await logMessages(ctx, outcome.runRid, "test")).join("\n");
    expect(testLog).toContain("second fails");
    expect(testLog).toContain("tests failed: 1 of 3 test(s)");
    const versions = await ctx.query(
      `SELECT COUNT(*)::int AS n FROM function_version fv
        JOIN jemma_run r ON r.rid = $1 AND fv.repository_rid = r.repository_rid`,
      [outcome.runRid],
    );
    expect(versions.rows[0].n).toBe(0);
  });

  it("fails the run when a test file throws during module loading", async () => {
    stemma.files.set("typescript-functions/src/functions/alpha.ts", functionSource("alpha"));
    stemma.files.set("typescript-functions/src/functions/broken.test.ts",
      "throw new Error(\"boom at module load\");\n");
    const outcome = await runPublish(ctx, stemma);
    expect(outcome.state).toBe("FAILED");
    expect((await stageStates(ctx, outcome.runRid)).test).toBe("FAILED");
    expect((await logMessages(ctx, outcome.runRid, "test")).join("\n")).toContain("boom at module load");
  });

  it("kills a hanging test at the configured timeout, reaps the child, cleans the temp dir", async () => {
    stemma.files.set("typescript-functions/src/functions/alpha.ts", functionSource("alpha"));
    stemma.files.set("typescript-functions/src/functions/hang.test.ts", `
import { test } from "node:test";
test("hangs forever", async () => { await new Promise(() => {}); });
`);
    const spawnedPids: number[] = [];
    const tmpBefore = new Set(readdirSync(tmpdir()));
    const outcome = await runPublish(ctx, stemma, {
      timeoutMs: 1_000,
      killGraceMs: 300,
      onChildSpawned: (pid) => spawnedPids.push(pid),
    });
    expect(outcome.state).toBe("FAILED");
    expect((await stageStates(ctx, outcome.runRid)).test).toBe("FAILED");
    expect((await logMessages(ctx, outcome.runRid, "test")).join("\n")).toContain("timeout");

    // No orphan child: every spawned PID is gone.
    expect(spawnedPids.length).toBeGreaterThan(0);
    for (const pid of spawnedPids) {
      expect(() => process.kill(pid, 0)).toThrow();
    }
    // No leftover jemma-test-* temp directories.
    const tmpAfter = readdirSync(tmpdir());
    expect(tmpAfter.filter((name) => name.startsWith("jemma-test-") && !tmpBefore.has(name))).toEqual([]);
  }, 20_000);
});

// ---------------------------------------------------------------------------
// Track 1 items #3 (lease heartbeat) and #4 (transient retry/backoff).
// ---------------------------------------------------------------------------

/** Stemma double with deterministic failure injection at call boundaries. */
class ChaosStemma extends FakeStemma {
  listTreeCalls = 0;
  readonly transientListTreeCalls = new Set<number>();
  transientListTreeFromCall: number | null = null;
  readBlobGate: Promise<void> | null = null;
  /** Fires when the worker is INSIDE readBlob (about to await the gate). */
  readBlobEntered: (() => void) | null = null;

  override async listTree(args: StemmaListTreeArgs): Promise<StemmaListTreeOutcome> {
    this.listTreeCalls += 1;
    if (this.transientListTreeCalls.has(this.listTreeCalls)
      || (this.transientListTreeFromCall !== null && this.listTreeCalls >= this.transientListTreeFromCall)) {
      return { kind: "transient", reason: "injected-transient" };
    }
    return super.listTree(args);
  }

  override async readBlob(args: StemmaReadBlobArgs): Promise<StemmaReadBlobOutcome> {
    this.readBlobEntered?.();
    if (this.readBlobGate) await this.readBlobGate;
    return super.readBlob(args);
  }
}

/** Pool wrapper failing the first N queries matching a pattern with a pg-style error. */
class FlakyPool {
  constructor(
    private readonly real: Pool,
    private readonly failOn: RegExp,
    private remaining: number,
    private readonly code: string,
  ) {}

  query(...args: unknown[]): Promise<unknown> {
    if (this.remaining > 0 && this.failOn.test(String(args[0]))) {
      this.remaining -= 1;
      const error = new Error(`injected transient (${this.code})`) as Error & { code: string };
      error.code = this.code;
      return Promise.reject(error);
    }
    return (this.real as { query: (...a: unknown[]) => Promise<unknown> }).query(...args);
  }

  connect(): ReturnType<Pool["connect"]> {
    return this.real.connect();
  }

  on(): this {
    return this;
  }

  async end(): Promise<void> {
    /* owned by the test context */
  }
}

/** Pool wrapper observing lease-renewal queries for overlap/cleanup assertions. */
class RenewalWatchPool extends FlakyPool {
  renewals = 0;
  inFlight = 0;
  maxInFlight = 0;

  override async query(...args: unknown[]): Promise<unknown> {
    const isRenewal = /\/\* heartbeat \*\//.test(String(args[0]));
    if (isRenewal) {
      this.renewals += 1;
      this.inFlight += 1;
      this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    }
    try {
      return await super.query(...args);
    } finally {
      if (isRenewal) this.inFlight -= 1;
    }
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => { resolve = res; });
  return { promise, resolve };
}

async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs = 15_000,
  description = "condition",
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const FAST_RETRY = {
  // 15s TTL (7.5s authority horizon): dev-box event-loop
  // stalls of many seconds have been observed under suite
  // load (a 13.7s stall once orphaned a run mid-iteration).
  // The production TTL (600s) dwarfs the same stalls; the
  // test TTL must scale the same way or the safety
  // deadline fires spuriously. Heartbeat/backoff timings
  // (the things under test) are unchanged.
  leaseTtlMs: 15_000,
  heartbeatIntervalMs: 50,
  retryBaseDelayMs: 10,
  retryMaxDelayMs: 30,
  random: () => 0.5,
} as const;

const FAST_HB = {
  leaseTtlMs: 700,
  heartbeatIntervalMs: 100,
  retryBaseDelayMs: 10,
  retryMaxDelayMs: 20,
  random: () => 0.5,
} as const;

async function runRow(ctx: SchemaContext, runRid: string): Promise<{
  state: string; retry_count: number; lease_owner: string | null; pod_name: string | null;
}> {
  const result = await ctx.query<{
    state: string; retry_count: number; lease_owner: string | null; pod_name: string | null;
  }>(`SELECT state, retry_count, lease_owner, pod_name FROM jemma_run WHERE rid = $1`, [runRid]);
  return result.rows[0];
}

async function publishRunCount(ctx: SchemaContext, repoRid: string): Promise<number> {
  const result = await ctx.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM jemma_run r
      JOIN function_publish_request p ON p.run_rid = r.rid
     WHERE p.repository_rid = $1`,
    [repoRid],
  );
  return result.rows[0].n;
}

describe("functions-publish retry/backoff (item #4)", () => {
  let ctx: SchemaContext;
  let stemma: ChaosStemma;

  beforeEach(async () => {
    ctx = await openTestSchema("functions_publish_retry");
    await applyPublishMigrations(ctx);
    stemma = new ChaosStemma();
    stemma.files.set("typescript-functions/src/functions/alpha.ts", functionSource("alpha"));
  });

  afterEach(async () => {
    await stopTrackedServices();
    await ctx.close();
  });

  it("retries a transient stemma error on the SAME run row", async () => {
    stemma.files.set("typescript-functions/src/functions/alpha.ts", functionSource("alpha"));
    // Call 1 is enqueue's listTree; call 2 is the run's first setup attempt.
    stemma.transientListTreeCalls.add(2);

    const outcome = await runPublish(ctx, stemma, {}, FAST_RETRY);
    expect(outcome.state).toBe("SUCCEEDED");

    const run = await runRow(ctx, outcome.runRid);
    expect(run.retry_count).toBe(1);
    // One semantic run: one run row, five stage rows, one version.
    expect(await publishRunCount(ctx, outcome.repoRid)).toBe(1);
    const stages = await ctx.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM jemma_run_stage WHERE run_rid = $1`, [outcome.runRid]);
    expect(stages.rows[0].n).toBe(5);
    const logs = (await logMessages(ctx, outcome.runRid, "setup")).join("\n");
    expect(logs).toContain("Transient error (adapter transient); retry 1 of 3");
    const versions = await ctx.query(
      `SELECT semver FROM function_version WHERE repository_rid = $1`, [outcome.repoRid]);
    expect(versions.rows).toEqual([{ semver: "1.0.0" }]);
  });

  it("exhausts the retry budget and lands in the existing final failure path", async () => {
    stemma.transientListTreeFromCall = 2; // every setup attempt fails transiently
    const outcome = await runPublish(ctx, stemma, {}, { ...FAST_RETRY, maxTransientRetries: 2 });
    expect(outcome.state).toBe("FAILED");
    const run = await runRow(ctx, outcome.runRid);
    expect(run.retry_count).toBe(2);
    expect(await stageStates(ctx, outcome.runRid)).toMatchObject({
      setup: "FAILED", lint: "SKIPPED", test: "SKIPPED", build: "SKIPPED", publish: "SKIPPED",
    });
    expect(await publishRunCount(ctx, outcome.repoRid)).toBe(1);
    const logs = (await logMessages(ctx, outcome.runRid, "setup")).join("\n");
    expect(logs).toContain("retry 1 of 2");
    expect(logs).toContain("retry 2 of 2");
    const versions = await ctx.query(
      `SELECT COUNT(*)::int AS n FROM function_version WHERE repository_rid = $1`, [outcome.repoRid]);
    expect(versions.rows[0].n).toBe(0);
  });

  it("keeps the stage RUNNING (never transiently FAILED) during backoff, then recovers", async () => {
    stemma.transientListTreeCalls.add(2);
    const gate = deferred();
    const service = trackService(new FunctionsPublishService(
      { pool: ctx.pool, stemma }, 1, {},
      { ...FAST_RETRY, sleep: () => gate.promise },
    ));
    try {
      const repoRid = `ri.stemma.main.repository.00000000-0000-0000-0000-${randomUUID().slice(0, 12)}`;
      const enqueued = await service.enqueue({
        repositoryRid: repoRid, branch: "main", defaultBranch: "main",
        semver: "1.0.0", message: null, triggeredBy: randomUUID(), idempotencyKey: randomUUID(),
      });
      await waitFor(async () => (await runRow(ctx, enqueued.runRid)).retry_count === 1,
        10_000, "retry_count = 1");
      // Mid-backoff: run and stage are still RUNNING — no transient FAILED.
      const run = await runRow(ctx, enqueued.runRid);
      expect(run.state).toBe("RUNNING");
      expect((await stageStates(ctx, enqueued.runRid)).setup).toBe("RUNNING");
      gate.resolve();
      expect(await waitForTerminal(ctx.pool, enqueued.runRid)).toBe("SUCCEEDED");
      expect(await publishRunCount(ctx, repoRid)).toBe(1);
    } finally {
      gate.resolve();
    }
  });

  it("aborts the retry when the run is cancelled during backoff", async () => {
    stemma.transientListTreeCalls.add(2);
    const gate = deferred();
    const service = trackService(new FunctionsPublishService(
      { pool: ctx.pool, stemma }, 1, {},
      { ...FAST_RETRY, sleep: () => gate.promise },
    ));
    try {
      const repoRid = `ri.stemma.main.repository.00000000-0000-0000-0000-${randomUUID().slice(0, 12)}`;
      const enqueued = await service.enqueue({
        repositoryRid: repoRid, branch: "main", defaultBranch: "main",
        semver: "1.0.0", message: null, triggeredBy: randomUUID(), idempotencyKey: randomUUID(),
      });
      await waitFor(async () => (await runRow(ctx, enqueued.runRid)).retry_count === 1,
        10_000, "retry_count = 1");
      await service.cancel(enqueued.runRid);
      // The next heartbeat (50ms) notices the lost lease; release the
      // gate only after authority loss had a chance to land.
      await new Promise((resolve) => setTimeout(resolve, 300));
      gate.resolve();
      await new Promise((resolve) => setTimeout(resolve, 300));
      const run = await runRow(ctx, enqueued.runRid);
      expect(run.state).toBe("CANCELLED");
      expect(run.retry_count).toBe(1); // no further retry mutation
      // cancel() finalizes the active stage — nothing left RUNNING,
      // and the losing worker did NOT mark it FAILED.
      expect((await stageStates(ctx, enqueued.runRid)).setup).toBe("SKIPPED");
      const versions = await ctx.query(
        `SELECT COUNT(*)::int AS n FROM function_version WHERE repository_rid = $1`, [repoRid]);
      expect(versions.rows[0].n).toBe(0);
    } finally {
      gate.resolve();
    }
  });

  it("aborts the retry when the lease is lost during backoff", async () => {
    stemma.transientListTreeCalls.add(2);
    const gate = deferred();
    const service = trackService(new FunctionsPublishService(
      { pool: ctx.pool, stemma }, 1, {},
      { ...FAST_RETRY, sleep: () => gate.promise },
    ));
    try {
      const repoRid = `ri.stemma.main.repository.00000000-0000-0000-0000-${randomUUID().slice(0, 12)}`;
      const enqueued = await service.enqueue({
        repositoryRid: repoRid, branch: "main", defaultBranch: "main",
        semver: "1.0.0", message: null, triggeredBy: randomUUID(), idempotencyKey: randomUUID(),
      });
      await waitFor(async () => (await runRow(ctx, enqueued.runRid)).retry_count === 1,
        10_000, "retry_count = 1");
      // Simulate a reclaimer taking over.
      await ctx.query(
        `UPDATE jemma_run SET lease_owner = 'someone-else' WHERE rid = $1`, [enqueued.runRid]);
      await new Promise((resolve) => setTimeout(resolve, 300));
      gate.resolve();
      await new Promise((resolve) => setTimeout(resolve, 300));
      const run = await runRow(ctx, enqueued.runRid);
      // The stale worker changed nothing further.
      expect(run.lease_owner).toBe("someone-else");
      expect(run.state).toBe("RUNNING");
      expect(run.retry_count).toBe(1);
    } finally {
      gate.resolve();
    }
  });

  it("survives an ambiguous publish write (transient failure after commit) without duplicates", async () => {
    // First UPDATE of function_publish_request (after publishVersion
    // committed) fails with a retryable SQLSTATE.
    const pool = new FlakyPool(
      ctx.pool, /UPDATE function_publish_request\s+SET version_rid/, 1, "40001",
    );
    const outcome = await runPublish(ctx, stemma, {}, FAST_RETRY, pool as unknown as Pool);
    expect(outcome.state).toBe("SUCCEEDED");
    const run = await runRow(ctx, outcome.runRid);
    expect(run.retry_count).toBe(1);
    // Exactly one version row, one run row — the retried publish deduped.
    const versions = await ctx.query(
      `SELECT semver, artifact_sha256 FROM function_version WHERE repository_rid = $1`,
      [outcome.repoRid]);
    expect(versions.rows.length).toBe(1);
    expect(await publishRunCount(ctx, outcome.repoRid)).toBe(1);
  });

  it("lets only the lease owner reserve a retry (SQL race, real Postgres)", async () => {
    const rid = `ri.jemma.main.run.${randomUUID()}`;
    await ctx.query(
      `INSERT INTO jemma_run (rid, repository_rid, ref, commit_sha, trigger_kind, triggered_by,
                              state, job_name, lease_owner, started_at)
       VALUES ($1, 'repo', 'main', 'abcdef0', 'MANUAL', $2, 'RUNNING', 'functions-publish', 'worker-A', now())`,
      [rid, randomUUID()],
    );
    const reserve = (owner: string) => ctx.query<{ retry_count: number }>(
      `UPDATE jemma_run
          SET retry_count = retry_count + 1
        WHERE rid = $1 AND lease_owner = $2 AND state = 'RUNNING' AND retry_count < $3
        RETURNING retry_count`,
      [rid, owner, 3],
    );
    const [a, b] = await Promise.all([reserve("worker-A"), reserve("worker-B")]);
    expect(a.rows[0]?.retry_count).toBe(1);
    expect(b.rowCount).toBe(0);
    // Budget boundary: at the cap, even the owner reserves nothing.
    await ctx.query(`UPDATE jemma_run SET retry_count = 3 WHERE rid = $1`, [rid]);
    expect((await reserve("worker-A")).rowCount).toBe(0);
  });

  it("dedups a same-semver re-tag to the burned FAILED run (deterministic failure)", async () => {
    stemma.files.set("typescript-functions/src/functions/alpha.ts",
      "export default function alpha(input: string): string { const n: number = \"x\"; return String(n); }\n");
    const outcome = await runPublish(ctx, stemma, {}, FAST_RETRY);
    expect(outcome.state).toBe("FAILED");
    expect((await runRow(ctx, outcome.runRid)).retry_count).toBe(0);

    // Real enqueue path: same repo/branch/semver returns the burned run.
    const service = trackService(new FunctionsPublishService({ pool: ctx.pool, stemma }));
    const again = await service.enqueue({
      repositoryRid: outcome.repoRid, branch: "main", defaultBranch: "main",
      semver: "1.0.0", message: null, triggeredBy: randomUUID(), idempotencyKey: randomUUID(),
    });
    expect(again.replayed).toBe(true);
    expect(again.runRid).toBe(outcome.runRid);
    expect(again.state).toBe("FAILED");
    // Exactly one run row for this identity; retry_count untouched.
    const rows = await ctx.query<{ rid: string; retry_count: number }>(
      `SELECT r.rid, r.retry_count FROM jemma_run r
        JOIN function_publish_request p ON p.run_rid = r.rid
       WHERE p.repository_rid = $1 AND p.branch = 'main' AND p.semver = '1.0.0'`,
      [outcome.repoRid]);
    expect(rows.rows).toEqual([{ rid: outcome.runRid, retry_count: 0 }]);

    // A genuinely new tag (new semver) creates a new run.
    const fresh = await service.enqueue({
      repositoryRid: outcome.repoRid, branch: "main", defaultBranch: "main",
      semver: "1.0.1", message: null, triggeredBy: randomUUID(), idempotencyKey: randomUUID(),
    });
    expect(fresh.replayed).toBe(false);
    expect(fresh.runRid).not.toBe(outcome.runRid);
    await waitForTerminal(ctx.pool, fresh.runRid);
  });
});

describe("functions-publish lease heartbeat (item #3)", () => {
  let ctx: SchemaContext;
  let stemma: ChaosStemma;

  beforeEach(async () => {
    ctx = await openTestSchema("functions_publish_lease");
    await applyPublishMigrations(ctx);
    stemma = new ChaosStemma();
    stemma.files.set("typescript-functions/src/functions/alpha.ts", functionSource("alpha"));
  });

  afterEach(async () => {
    await stopTrackedServices();
    await ctx.close();
  });

  it("renews lease_expires_at while a slow stage runs; run stays with the owner", async () => {
    stemma.files.set("typescript-functions/src/functions/alpha.ts", functionSource("alpha"));
    const gate = deferred();
    stemma.readBlobGate = gate.promise;
    setTimeout(() => gate.resolve(), 600);
    // leaseTtl 20000 (horizon 10s after each confirmed renewal):
    // leases run on PG server time while renewals run on this
    // process's event loop — a multi-second box stall (13.7s
    // observed under suite load) lapses any shorter TTL no
    // matter what the worker does. The production TTL (600s)
    // dwarfs the same stalls; the test TTL scales the same way.
    // The renewal assertion is unchanged.
    const service = trackService(new FunctionsPublishService({ pool: ctx.pool, stemma }, 1, {},
      { ...FAST_HB, leaseTtlMs: 20_000 }));
    try {
      const repoRid = `ri.stemma.main.repository.00000000-0000-0000-0000-${randomUUID().slice(0, 12)}`;
      const enqueued = await service.enqueue({
        repositoryRid: repoRid, branch: "main", defaultBranch: "main",
        semver: "1.0.0", message: null, triggeredBy: randomUUID(), idempotencyKey: randomUUID(),
      });
      await waitFor(async () => (await runRow(ctx, enqueued.runRid)).state === "RUNNING",
        10_000, "RUNNING");
      const first = await ctx.query<{ t: Date }>(
        `SELECT lease_expires_at AS t FROM jemma_run WHERE rid = $1`, [enqueued.runRid]);
      await new Promise((resolve) => setTimeout(resolve, 350));
      const second = await ctx.query<{ t: Date }>(
        `SELECT lease_expires_at AS t FROM jemma_run WHERE rid = $1`, [enqueued.runRid]);
      expect(second.rows[0].t.getTime()).toBeGreaterThan(first.rows[0].t.getTime());
      expect(await waitForTerminal(ctx.pool, enqueued.runRid)).toBe("SUCCEEDED");
      expect((await runRow(ctx, enqueued.runRid)).retry_count).toBe(0);
    } finally {
      gate.resolve();
      stemma.readBlobGate = null;
    }
  });

  it("renewal requires the correct lease_owner (SQL, real Postgres)", async () => {
    const rid = `ri.jemma.main.run.${randomUUID()}`;
    await ctx.query(
      `INSERT INTO jemma_run (rid, repository_rid, ref, commit_sha, trigger_kind, triggered_by,
                              state, job_name, lease_owner, lease_expires_at, started_at)
       VALUES ($1, 'repo', 'main', 'abcdef0', 'MANUAL', $2, 'RUNNING', 'functions-publish',
               'worker-A', now() + interval '10 seconds', now())`,
      [rid, randomUUID()],
    );
    const renew = (owner: string) => ctx.query(
      `UPDATE jemma_run
          SET lease_expires_at = now() + interval '10 minutes'
        WHERE rid = $1 AND lease_owner = $2 AND state = 'RUNNING'`,
      [rid, owner],
    );
    expect((await renew("worker-B")).rowCount).toBe(0);
    expect((await renew("worker-A")).rowCount).toBe(1);
    const extended = await ctx.query<{ t: Date }>(
      `SELECT lease_expires_at AS t FROM jemma_run WHERE rid = $1`, [rid]);
    expect(extended.rows[0].t.getTime()).toBeGreaterThan(Date.now() + 60_000);
    // After cancellation the same renewal affects zero rows.
    await ctx.query(
      `UPDATE jemma_run SET state = 'CANCELLED', finished_at = now(), lease_owner = NULL WHERE rid = $1`,
      [rid]);
    expect((await renew("worker-A")).rowCount).toBe(0);
  });

  it("stops after cancellation mid-stage and preserves CANCELLED (no FAILED overwrite)", async () => {
    stemma.files.set("typescript-functions/src/functions/alpha.ts", functionSource("alpha"));
    const gate = deferred();
    stemma.readBlobGate = gate.promise;
    const service = trackService(new FunctionsPublishService({ pool: ctx.pool, stemma }, 1, {}, FAST_RETRY));
    try {
      const repoRid = `ri.stemma.main.repository.00000000-0000-0000-0000-${randomUUID().slice(0, 12)}`;
      const enqueued = await service.enqueue({
        repositoryRid: repoRid, branch: "main", defaultBranch: "main",
        semver: "1.0.0", message: null, triggeredBy: randomUUID(), idempotencyKey: randomUUID(),
      });
      await waitFor(async () => (await stageStates(ctx, enqueued.runRid)).setup === "RUNNING",
        10_000, "setup RUNNING");
      await service.cancel(enqueued.runRid);
      await new Promise((resolve) => setTimeout(resolve, 300));
      gate.resolve();
      await new Promise((resolve) => setTimeout(resolve, 300));
      const run = await runRow(ctx, enqueued.runRid);
      expect(run.state).toBe("CANCELLED");
      expect(run.retry_count).toBe(0);
      const stages = await stageStates(ctx, enqueued.runRid);
      // cancel() finalizes the active stage — nothing left RUNNING,
      // and the losing worker did NOT mark it FAILED.
      expect(stages.setup).toBe("SKIPPED");
      expect(stages.lint).toBe("SKIPPED");  // cancel() skipped the rest
      expect(stages.publish).toBe("SKIPPED");
      expect(Object.values(stages)).not.toContain("RUNNING");
      expect(Object.values(stages)).not.toContain("FAILED");
      const logs = (await logMessages(ctx, enqueued.runRid, "publish")).join("\n");
      expect(logs).not.toContain("Registered");
      const allLogs = await ctx.query<{ message: string }>(
        `SELECT message FROM jemma_run_log WHERE run_rid = $1`, [enqueued.runRid]);
      expect(allLogs.rows.map((row) => row.message).join("\n")).not.toContain("BUILD SUCCESSFUL");
      const versions = await ctx.query(
        `SELECT COUNT(*)::int AS n FROM function_version WHERE repository_rid = $1`, [repoRid]);
      expect(versions.rows[0].n).toBe(0);
    } finally {
      gate.resolve();
      stemma.readBlobGate = null;
    }
  });

  it("loses the reclaim race: worker A cannot overwrite worker B's state", async () => {
    stemma.files.set("typescript-functions/src/functions/alpha.ts", functionSource("alpha"));
    const gate = deferred();
    stemma.readBlobGate = gate.promise;
    // A's TTL must outlive box stalls until the test
    // force-expires the lease — the reclaim is driven by the
    // manual expiry, not by TTL lapse (see stall rationale above).
    const serviceA = trackService(new FunctionsPublishService({ pool: ctx.pool, stemma }, 1, {},
      { ...FAST_HB, leaseTtlMs: 20_000, heartbeatIntervalMs: 50 }));
    const stemmaB = new FakeStemma();
    stemmaB.files.set("typescript-functions/src/functions/alpha.ts", functionSource("alpha"));
    const serviceB = trackService(new FunctionsPublishService({ pool: ctx.pool, stemma: stemmaB }, 1, {}, FAST_RETRY));
    try {
      const repoRid = `ri.stemma.main.repository.00000000-0000-0000-0000-${randomUUID().slice(0, 12)}`;
      const enqueued = await serviceA.enqueue({
        repositoryRid: repoRid, branch: "main", defaultBranch: "main",
        semver: "1.0.0", message: null, triggeredBy: randomUUID(), idempotencyKey: randomUUID(),
      });
      await waitFor(async () => (await stageStates(ctx, enqueued.runRid)).setup === "RUNNING",
        10_000, "setup RUNNING (A)");
      const ownerA = (await runRow(ctx, enqueued.runRid)).lease_owner;
      // A stalls; force-expire A's lease so B can reclaim.
      await ctx.query(
        `UPDATE jemma_run SET lease_expires_at = now() - interval '1 second' WHERE rid = $1`,
        [enqueued.runRid]);
      serviceB.start();
      expect(await waitForTerminal(ctx.pool, enqueued.runRid, 20_000)).toBe("SUCCEEDED");
      // B completed the run; release A's stalled read — A must exit quietly.
      gate.resolve();
      await new Promise((resolve) => setTimeout(resolve, 400));
      const run = await runRow(ctx, enqueued.runRid);
      expect(run.state).toBe("SUCCEEDED");
      expect(run.lease_owner).not.toBe(ownerA);
      expect(run.retry_count).toBe(0);
      // No stage was left FAILED by the stale worker.
      const stages = Object.values(await stageStates(ctx, enqueued.runRid));
      expect(stages).not.toContain("FAILED");
    } finally {
      gate.resolve();
      stemma.readBlobGate = null;
    }
  }, 30_000);

  it("is not reclaimed while heartbeats succeed, even past the original TTL", async () => {
    stemma.files.set("typescript-functions/src/functions/alpha.ts", functionSource("alpha"));
    const gate = deferred();
    stemma.readBlobGate = gate.promise;
    // Stage outlives the 20000ms TTL (see the stall rationale on
    // the "renews lease_expires_at" test).
    setTimeout(() => gate.resolve(), 21_000);
    const serviceA = trackService(new FunctionsPublishService({ pool: ctx.pool, stemma }, 1, {},
      { ...FAST_HB, leaseTtlMs: 20_000 }));
    const stemmaB = new FakeStemma();
    stemmaB.files.set("typescript-functions/src/functions/alpha.ts", functionSource("alpha"));
    const serviceB = trackService(new FunctionsPublishService({ pool: ctx.pool, stemma: stemmaB }, 1, {}, FAST_RETRY));
    try {
      const repoRid = `ri.stemma.main.repository.00000000-0000-0000-0000-${randomUUID().slice(0, 12)}`;
      const enqueued = await serviceA.enqueue({
        repositoryRid: repoRid, branch: "main", defaultBranch: "main",
        semver: "1.0.0", message: null, triggeredBy: randomUUID(), idempotencyKey: randomUUID(),
      });
      await waitFor(async () => (await runRow(ctx, enqueued.runRid)).state === "RUNNING",
        10_000, "RUNNING");
      const ownerA = (await runRow(ctx, enqueued.runRid)).pod_name;
      serviceB.start();
      // 45s: the gate holds the stage for 21s by design.
      expect(await waitForTerminal(ctx.pool, enqueued.runRid, 45_000)).toBe("SUCCEEDED");
      // B polled throughout but never reclaimed: ownership never moved.
      expect((await runRow(ctx, enqueued.runRid)).pod_name).toBe(ownerA);
      expect((await runRow(ctx, enqueued.runRid)).retry_count).toBe(0);
    } finally {
      gate.resolve();
      stemma.readBlobGate = null;
    }
  }, 60_000);

  it("never overlaps renewal queries and stops renewing after the run finishes", async () => {
    const pool = new RenewalWatchPool(ctx.pool, /$^/, 0, "00000"); // failOn matches nothing
    stemma.files.set("typescript-functions/src/functions/alpha.ts", functionSource("alpha"));
    const outcome = await runPublish(ctx, stemma, {}, FAST_RETRY, pool as unknown as Pool);
    expect(outcome.state).toBe("SUCCEEDED");
    expect(pool.renewals).toBeGreaterThan(0);
    expect(pool.maxInFlight).toBe(1);
    const renewalsAtEnd = pool.renewals;
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(pool.renewals).toBe(renewalsAtEnd); // heartbeat cleaned up on success
  });

  it("tolerates a transient DB error on a heartbeat renewal without failing the run", async () => {
    const pool = new FlakyPool(ctx.pool, /\/\* heartbeat \*\//, 1, "08006");
    const outcome = await runPublish(ctx, stemma, {}, FAST_RETRY, pool as unknown as Pool);
    expect(outcome.state).toBe("SUCCEEDED");
    expect((await runRow(ctx, outcome.runRid)).retry_count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Remediation: authority safety deadline (#3 gap), worker shutdown (#3 gap),
// cancellation stage finalization (#4 gap).
// ---------------------------------------------------------------------------

describe("functions-publish authority safety deadline", () => {
  let ctx: SchemaContext;
  let stemma: ChaosStemma;

  beforeEach(async () => {
    ctx = await openTestSchema("functions_publish_deadline");
    await applyPublishMigrations(ctx);
    stemma = new ChaosStemma();
    stemma.files.set("typescript-functions/src/functions/alpha.ts", functionSource("alpha"));
  });

  afterEach(async () => {
    await stopTrackedServices();
    await ctx.close();
  });

  it("loses authority at the local deadline under a persistent heartbeat outage", async () => {
    // Every heartbeat renewal fails transiently; the deadline
    // (leaseTtl 700ms - margin 350ms = 350ms) must stop the worker
    // long before the gate releases at ~3s.
    const pool = new FlakyPool(ctx.pool, /\/\* heartbeat \*\//, 1_000, "08006");
    const gate = deferred();
    stemma.readBlobGate = gate.promise;
    setTimeout(() => gate.resolve(), 3_000);
    const authorityLost = deferred();
    const spawnedPids: number[] = [];
    const service = trackService(new FunctionsPublishService(
      { pool: pool as unknown as Pool, stemma }, 1,
      { onChildSpawned: (pid) => spawnedPids.push(pid) },
      { ...FAST_HB, onAuthorityLost: () => authorityLost.resolve() },
    ));
    try {
      const repoRid = `ri.stemma.main.repository.00000000-0000-0000-0000-${randomUUID().slice(0, 12)}`;
      const enqueued = await service.enqueue({
        repositoryRid: repoRid, branch: "main", defaultBranch: "main",
        semver: "1.0.0", message: null, triggeredBy: randomUUID(), idempotencyKey: randomUUID(),
      });
      await authorityLost.promise; // deadline reached → authority lost
      gate.resolve();
      await new Promise((resolve) => setTimeout(resolve, 400));
      const run = await runRow(ctx, enqueued.runRid);
      // The run is NOT failed by the out-of-authority worker…
      expect(run.state).toBe("RUNNING");
      expect(run.retry_count).toBe(0);
      const stages = await stageStates(ctx, enqueued.runRid);
      // …no stage succeeds after the deadline…
      expect(stages.setup).toBe("RUNNING");
      // …and no NEW stage begins after the deadline.
      expect(stages.lint).toBe("PENDING");
      expect(stages.test).toBe("PENDING");
      // No test subprocess was ever launched.
      expect(spawnedPids).toEqual([]);
      // No artifact.
      const versions = await ctx.query(
        `SELECT COUNT(*)::int AS n FROM function_version WHERE repository_rid = $1`, [repoRid]);
      expect(versions.rows[0].n).toBe(0);
    } finally {
      gate.resolve();
      stemma.readBlobGate = null;
      await service.stop();
    }
  }, 20_000);

  it("interrupts a running backoff at the deadline under a heartbeat outage", async () => {
    const pool = new FlakyPool(ctx.pool, /\/\* heartbeat \*\//, 1_000, "08006");
    stemma.transientListTreeCalls.add(2);
    const gate = deferred();
    const authorityLost = deferred();
    const service = trackService(new FunctionsPublishService(
      { pool: pool as unknown as Pool, stemma }, 1, {},
      { ...FAST_HB, sleep: () => gate.promise, onAuthorityLost: () => authorityLost.resolve() },
    ));
    try {
      const repoRid = `ri.stemma.main.repository.00000000-0000-0000-0000-${randomUUID().slice(0, 12)}`;
      const enqueued = await service.enqueue({
        repositoryRid: repoRid, branch: "main", defaultBranch: "main",
        semver: "1.0.0", message: null, triggeredBy: randomUUID(), idempotencyKey: randomUUID(),
      });
      await waitFor(async () => (await runRow(ctx, enqueued.runRid)).retry_count === 1,
        10_000, "retry_count = 1");
      await authorityLost.promise; // backoff aborted at the deadline
      gate.resolve();
      await new Promise((resolve) => setTimeout(resolve, 400));
      const run = await runRow(ctx, enqueued.runRid);
      // No retry began after the deadline; nothing was failed.
      expect(run.state).toBe("RUNNING");
      expect(run.retry_count).toBe(1);
      const logs = (await logMessages(ctx, enqueued.runRid, "setup")).join("\n");
      expect(logs).toContain("retry 1 of 3");
      expect(logs).not.toContain("retry 2 of 3");
    } finally {
      gate.resolve();
      await service.stop();
    }
  }, 20_000);
});

describe("functions-publish worker shutdown (abort-and-drain)", () => {
  let ctx: SchemaContext;
  let stemma: ChaosStemma;

  beforeEach(async () => {
    ctx = await openTestSchema("functions_publish_shutdown");
    await applyPublishMigrations(ctx);
    stemma = new ChaosStemma();
    stemma.files.set("typescript-functions/src/functions/alpha.ts", functionSource("alpha"));
  });

  afterEach(async () => {
    await stopTrackedServices();
    await ctx.close();
  });

  it("stop() prevents new claims; a second stop() is safe", async () => {
    const service = trackService(new FunctionsPublishService({ pool: ctx.pool, stemma }, 1, {}, FAST_RETRY));
    await service.stop();
    await service.stop(); // idempotent
    const enqueued = await service.enqueue({
      repositoryRid: `ri.stemma.main.repository.00000000-0000-0000-0000-${randomUUID().slice(0, 12)}`,
      branch: "main", defaultBranch: "main",
      semver: "1.0.0", message: null, triggeredBy: randomUUID(), idempotencyKey: randomUUID(),
    });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect((await runRow(ctx, enqueued.runRid)).state).toBe("QUEUED");
  });

  it("stop() during retry backoff interrupts the retry and drains", async () => {
    stemma.transientListTreeCalls.add(2);
    const gate = deferred();
    const authorityLost = deferred();
    const service = trackService(new FunctionsPublishService(
      { pool: ctx.pool, stemma }, 1, {},
      { ...FAST_RETRY, sleep: () => gate.promise, onAuthorityLost: () => authorityLost.resolve() },
    ));
    try {
      const repoRid = `ri.stemma.main.repository.00000000-0000-0000-0000-${randomUUID().slice(0, 12)}`;
      const enqueued = await service.enqueue({
        repositoryRid: repoRid, branch: "main", defaultBranch: "main",
        semver: "1.0.0", message: null, triggeredBy: randomUUID(), idempotencyKey: randomUUID(),
      });
      await waitFor(async () => (await runRow(ctx, enqueued.runRid)).retry_count === 1,
        10_000, "retry_count = 1");
      const started = Date.now();
      await service.stop(); // must interrupt backoff and drain
      expect(Date.now() - started).toBeLessThan(5_000);
      gate.resolve();
      const run = await runRow(ctx, enqueued.runRid);
      // Worker shutdown does NOT cancel or fail the run — the lease
      // lapses and the run stays RUNNING for a clean reclaim.
      expect(run.state).toBe("RUNNING");
      expect(run.retry_count).toBe(1);
    } finally {
      gate.resolve();
    }
  }, 20_000);

  it("stop() during a hanging test kills the child process group", async () => {
    stemma.files.set("typescript-functions/src/functions/hang.test.ts", `
import { test } from "node:test";
test("hangs forever", async () => { await new Promise(() => {}); });
`);
    const spawnedPids: number[] = [];
    const service = trackService(new FunctionsPublishService(
      { pool: ctx.pool, stemma }, 1,
      { timeoutMs: 60_000, onChildSpawned: (pid) => spawnedPids.push(pid) },
      FAST_RETRY,
    ));
    const repoRid = `ri.stemma.main.repository.00000000-0000-0000-0000-${randomUUID().slice(0, 12)}`;
    const enqueued = await service.enqueue({
      repositoryRid: repoRid, branch: "main", defaultBranch: "main",
      semver: "1.0.0", message: null, triggeredBy: randomUUID(), idempotencyKey: randomUUID(),
    });
    await waitFor(() => Promise.resolve(spawnedPids.length > 0), 10_000, "test child spawned");
    await service.stop();
    expect(spawnedPids.length).toBeGreaterThan(0);
    for (const pid of spawnedPids) {
      expect(() => process.kill(pid, 0)).toThrow(); // reaped
    }
    // The run is not failed by the shutting-down worker.
    expect((await runRow(ctx, enqueued.runRid)).state).toBe("RUNNING");
  }, 20_000);

  it("stop() returns within the grace period even if an execution cannot settle", async () => {
    const gate = deferred(); // never released until after stop()
    stemma.readBlobGate = gate.promise;
    // RUNNING in the DB only proves the claim happened — the grace
    // assertion needs the execution IRREVOCABLY parked on the blob
    // gate, so wait for the actual readBlob entry.
    const parked = deferred();
    stemma.readBlobEntered = () => parked.resolve();
    const service = trackService(new FunctionsPublishService(
      { pool: ctx.pool, stemma }, 1, {},
      { ...FAST_RETRY, shutdownGraceMs: 500 },
    ));
    try {
      const enqueued = await service.enqueue({
        repositoryRid: `ri.stemma.main.repository.00000000-0000-0000-0000-${randomUUID().slice(0, 12)}`,
        branch: "main", defaultBranch: "main",
        semver: "1.0.0", message: null, triggeredBy: randomUUID(), idempotencyKey: randomUUID(),
      });
      await parked.promise;
      const started = Date.now();
      await service.stop();
      const elapsed = Date.now() - started;
      expect(elapsed).toBeGreaterThanOrEqual(400);
      expect(elapsed).toBeLessThan(4_000); // bounded by the grace period
    } finally {
      gate.resolve(); // let the orphaned execution finish settling
      stemma.readBlobGate = null;
      stemma.readBlobEntered = null;
    }
  }, 20_000);

  it("a worker stopped mid-stage cannot publish; a fresh worker completes the run", async () => {
    const gate = deferred();
    stemma.readBlobGate = gate.promise;
    const serviceA = trackService(new FunctionsPublishService({ pool: ctx.pool, stemma }, 1, {},
      { ...FAST_HB, shutdownGraceMs: 300 }));
    const repoRid = `ri.stemma.main.repository.00000000-0000-0000-0000-${randomUUID().slice(0, 12)}`;
    const enqueued = await serviceA.enqueue({
      repositoryRid: repoRid, branch: "main", defaultBranch: "main",
      semver: "1.0.0", message: null, triggeredBy: randomUUID(), idempotencyKey: randomUUID(),
    });
    await waitFor(async () => (await stageStates(ctx, enqueued.runRid)).setup === "RUNNING",
      10_000, "setup RUNNING");
    await serviceA.stop();
    gate.resolve();
    stemma.readBlobGate = null;
    await new Promise((resolve) => setTimeout(resolve, 400));
    // A published nothing.
    let versions = await ctx.query(
      `SELECT COUNT(*)::int AS n FROM function_version WHERE repository_rid = $1`, [repoRid]);
    expect(versions.rows[0].n).toBe(0);
    expect((await runRow(ctx, enqueued.runRid)).state).toBe("RUNNING");
    // Expire the abandoned lease; a fresh worker reclaims and completes.
    await ctx.query(
      `UPDATE jemma_run SET lease_expires_at = now() - interval '1 second' WHERE rid = $1`,
      [enqueued.runRid]);
    const stemmaB = new FakeStemma();
    stemmaB.files.set("typescript-functions/src/functions/alpha.ts", functionSource("alpha"));
    const serviceB = trackService(new FunctionsPublishService({ pool: ctx.pool, stemma: stemmaB }, 1, {}, FAST_RETRY));
    serviceB.start();
    expect(await waitForTerminal(ctx.pool, enqueued.runRid, 20_000)).toBe("SUCCEEDED");
    await serviceB.stop();
    versions = await ctx.query(
      `SELECT COUNT(*)::int AS n FROM function_version WHERE repository_rid = $1`, [repoRid]);
    expect(versions.rows[0].n).toBe(1); // exactly one publication
  }, 30_000);
});

describe("functions-publish cancellation finalization", () => {
  let ctx: SchemaContext;
  let stemma: ChaosStemma;

  beforeEach(async () => {
    ctx = await openTestSchema("functions_publish_cancel");
    await applyPublishMigrations(ctx);
    stemma = new ChaosStemma();
    stemma.files.set("typescript-functions/src/functions/alpha.ts", functionSource("alpha"));
  });

  afterEach(async () => {
    await stopTrackedServices();
    await ctx.close();
  });

  it("cancel during a hanging test kills the child and leaves no stage RUNNING", async () => {
    stemma.files.set("typescript-functions/src/functions/hang.test.ts", `
import { test } from "node:test";
test("hangs forever", async () => { await new Promise(() => {}); });
`);
    const spawnedPids: number[] = [];
    const service = trackService(new FunctionsPublishService(
      { pool: ctx.pool, stemma }, 1,
      { timeoutMs: 60_000, onChildSpawned: (pid) => spawnedPids.push(pid) },
      FAST_RETRY,
    ));
    const repoRid = `ri.stemma.main.repository.00000000-0000-0000-0000-${randomUUID().slice(0, 12)}`;
    const enqueued = await service.enqueue({
      repositoryRid: repoRid, branch: "main", defaultBranch: "main",
      semver: "1.0.0", message: null, triggeredBy: randomUUID(), idempotencyKey: randomUUID(),
    });
    await waitFor(() => Promise.resolve(spawnedPids.length > 0), 10_000, "test child spawned");
    expect(await service.cancel(enqueued.runRid)).toBe(true);
    // Idempotent: a second cancel changes nothing.
    expect(await service.cancel(enqueued.runRid)).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 300));
    for (const pid of spawnedPids) {
      expect(() => process.kill(pid, 0)).toThrow(); // child reaped
    }
    const stages = Object.values(await stageStates(ctx, enqueued.runRid));
    expect(stages).not.toContain("RUNNING");
    const run = await ctx.query<{ finished_at: Date | null; retry_count: number }>(
      `SELECT finished_at, retry_count FROM jemma_run WHERE rid = $1`, [enqueued.runRid]);
    expect(run.rows[0].finished_at).not.toBeNull();
    expect(run.rows[0].retry_count).toBe(0); // cancel never retries
    const stageRows = await ctx.query<{ finished_at: Date | null }>(
      `SELECT finished_at FROM jemma_run_stage WHERE run_rid = $1`, [enqueued.runRid]);
    for (const row of stageRows.rows) expect(row.finished_at).not.toBeNull();
    // Exactly one cancellation log line (no duplicates).
    const logs = await ctx.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM jemma_run_log
        WHERE run_rid = $1 AND message = 'Cancellation requested by user'`,
      [enqueued.runRid]);
    expect(logs.rows[0].n).toBe(1);
    const versions = await ctx.query(
      `SELECT COUNT(*)::int AS n FROM function_version WHERE repository_rid = $1`, [repoRid]);
    expect(versions.rows[0].n).toBe(0);
    await service.stop();
  }, 20_000);
});
