// ---------------------------------------------------------------------------
// Track 2 item #7 — enqueue-time active-run protection.
//
// Two independent Postgres clients race enqueue() against the REAL
// partial unique index (jemma_run_active_per_ref_uq). A deterministic
// barrier holds both INSERTs until both pre-checks have passed, so
// the index race is exercised on every run — not probabilistically.
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  FunctionsPublishError,
  FunctionsPublishService,
} from "../../../../src/services/functionsPublish/service";
import type {
  StemmaAdapter,
  StemmaListTreeArgs,
  StemmaListTreeOutcome,
  StemmaReadBlobArgs,
  StemmaReadBlobOutcome,
} from "../../../../src/services/codeRepository/adapters/types";
import { openTestSchema, type SchemaContext } from "../_helpers/pg";

// Real MinIO (the pump executes publishes end-to-end).
import "dotenv/config";
process.env.S3_ENDPOINT ??= "http://localhost:9000";
process.env.S3_BUCKET ??= "tellus-uploads";
process.env.S3_ACCESS_KEY_ID ??= "minioadmin";
process.env.S3_SECRET_ACCESS_KEY ??= "minioadmin";

const BRANCH_HEAD = "abcdef0123456789";

async function applyPublishMigrations(ctx: SchemaContext): Promise<void> {
  await ctx.applyMigration("src/migrations/054_b6_jemma.sql");
  await ctx.applyMigration("src/migrations/055_b8_functions_registry.sql");
  await ctx.applyMigration("src/migrations/116_functions_publish_jobs.sql");
  await ctx.applyMigration("src/migrations/118_functions_publish_retrigger.sql");
  await ctx.applyMigration("src/migrations/137_functions_publish_retry.sql");
  await ctx.applyMigration("src/migrations/139_function_kind.sql");
}

class FakeStemma implements StemmaAdapter {
  readonly files = new Map<string, string>([
    ["typescript-functions/src/functions/alpha.ts",
      "export default function alpha(input: string): string { return input; }\n"],
  ]);
  readBlobGate: Promise<void> | null = null;

  async listTree(args: StemmaListTreeArgs): Promise<StemmaListTreeOutcome> {
    void args;
    const entries = [...this.files.keys()].sort().map((path) => ({
      name: path.slice(path.lastIndexOf("/") + 1),
      path,
      type: "blob" as const,
      mode: "100644",
      sha: BRANCH_HEAD,
    }));
    return { kind: "ok", entries, truncated: false, branchHead: BRANCH_HEAD, treeSha: BRANCH_HEAD };
  }

  async readBlob(args: StemmaReadBlobArgs): Promise<StemmaReadBlobOutcome> {
    if (this.readBlobGate) await this.readBlobGate;
    const source = this.files.get(args.path);
    if (source === undefined) return { kind: "path-not-found" };
    const content = new TextEncoder().encode(source);
    return { kind: "ok", content, sha: BRANCH_HEAD, size: content.byteLength };
  }

  async createRepository(): Promise<never> { throw new Error("unused"); }
  async tombstone(): Promise<void> { throw new Error("unused"); }
  async commitFiles(): Promise<never> { throw new Error("unused"); }
  async createBranch(): Promise<never> { throw new Error("unused"); }
  async deleteBranch(): Promise<never> { throw new Error("unused"); }
  async listBranches(): Promise<never> { throw new Error("unused"); }
}

/** Release `parties` waiters only once ALL have arrived. */
function createBarrier(parties: number): { arrive: () => Promise<void> } {
  let arrived = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  return {
    async arrive(): Promise<void> {
      arrived += 1;
      if (arrived === parties) release();
      await gate;
    },
  };
}

/**
 * Pool wrapper that holds every query matching `pattern` (and every
 * matching query on clients from connect()) at a shared barrier —
 * two racing enqueues both reach their INSERT before either
 * proceeds, every time.
 */
class BarrierPool {
  constructor(
    private readonly real: Pool,
    private readonly barrier: { arrive: () => Promise<void> },
    private readonly pattern: RegExp,
  ) {}

  query(...args: unknown[]): Promise<unknown> {
    if (this.pattern.test(String(args[0]))) {
      return this.barrier.arrive().then(() =>
        (this.real as { query: (...a: unknown[]) => Promise<unknown> }).query(...args));
    }
    return (this.real as { query: (...a: unknown[]) => Promise<unknown> }).query(...args);
  }

  async connect(): Promise<PoolClient> {
    const client = await this.real.connect();
    const barrier = this.barrier;
    const pattern = this.pattern;
    return {
      async query(text: unknown, ...rest: unknown[]) {
        if (pattern.test(String(text))) await barrier.arrive();
        return client.query(text as string, ...(rest as never[]));
      },
      release() {
        client.release();
      },
    } as unknown as PoolClient;
  }

  on(): this {
    return this;
  }

  async end(): Promise<void> {
    /* owned by the test context */
  }
}

describe("functions-publish enqueue active-run protection (item #7)", () => {
  let ctx: SchemaContext;
  let stemma: FakeStemma;
  let services: FunctionsPublishService[];

  beforeEach(async () => {
    ctx = await openTestSchema("functions_publish_enq7");
    await applyPublishMigrations(ctx);
    stemma = new FakeStemma();
    services = [];
  });

  afterEach(async () => {
    for (const service of services.splice(0)) await service.stop();
    await ctx.close();
  });

  function makeService(pool: Pool): FunctionsPublishService {
    const service = new FunctionsPublishService({ pool, stemma });
    services.push(service);
    return service;
  }

  function enqueueArgs(overrides: Partial<{
    repositoryRid: string; branch: string; semver: string;
  }> = {}) {
    return {
      repositoryRid: overrides.repositoryRid
        ?? `ri.stemma.main.repository.00000000-0000-0000-0000-${randomUUID().slice(0, 12)}`,
      branch: overrides.branch ?? "main",
      defaultBranch: "main",
      semver: overrides.semver ?? "1.0.0",
      message: null,
      triggeredBy: randomUUID(),
      idempotencyKey: randomUUID(),
    };
  }

  it("two concurrent different-semver enqueues: one created, one structured 409-class conflict", async () => {
    const repositoryRid = `ri.stemma.main.repository.00000000-0000-0000-0000-${randomUUID().slice(0, 12)}`;
    const barrier = createBarrier(2);
    // Two INDEPENDENT pools (two clients) — the race is real.
    const serviceA = makeService(new BarrierPool(ctx.pool, barrier, /INSERT INTO jemma_run\b/) as unknown as Pool);
    const serviceB = makeService(new BarrierPool(ctx.pool, barrier, /INSERT INTO jemma_run\b/) as unknown as Pool);

    const [a, b] = await Promise.allSettled([
      serviceA.enqueue(enqueueArgs({ repositoryRid, semver: "1.0.0" })),
      serviceB.enqueue(enqueueArgs({ repositoryRid, semver: "1.0.1" })),
    ]);

    const outcomes = [a, b];
    const created = outcomes.filter(
      (o): o is PromiseFulfilledResult<Awaited<ReturnType<FunctionsPublishService["enqueue"]>>> =>
        o.status === "fulfilled" && !o.value.replayed,
    );
    const conflicts = outcomes.filter(
      (o): o is PromiseRejectedResult => o.status === "rejected",
    );
    expect(created).toHaveLength(1);
    expect(conflicts).toHaveLength(1);

    const error = conflicts[0].reason;
    expect(error).toBeInstanceOf(FunctionsPublishError);
    expect((error as FunctionsPublishError).code).toBe("RUN_ALREADY_ACTIVE");
    expect((error as FunctionsPublishError).details.activeRunRid).toBe(created[0].value.runRid);
    // No raw Postgres detail leaks.
    expect(String((error as Error).message)).not.toMatch(/duplicate key|23505|jemma_run_active/);

    // Exactly one active run row for the repo+branch.
    const rows = await ctx.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM jemma_run WHERE repository_rid = $1`,
      [repositoryRid],
    );
    expect(rows.rows[0].n).toBe(1);
  }, 20_000);

  it("two concurrent same-semver enqueues: one created, one deterministic replay", async () => {
    const repositoryRid = `ri.stemma.main.repository.00000000-0000-0000-0000-${randomUUID().slice(0, 12)}`;
    const barrier = createBarrier(2);
    const serviceA = makeService(new BarrierPool(ctx.pool, barrier, /INSERT INTO jemma_run\b/) as unknown as Pool);
    const serviceB = makeService(new BarrierPool(ctx.pool, barrier, /INSERT INTO jemma_run\b/) as unknown as Pool);

    const [a, b] = await Promise.all([
      serviceA.enqueue(enqueueArgs({ repositoryRid, semver: "1.0.0" })),
      serviceB.enqueue(enqueueArgs({ repositoryRid, semver: "1.0.0" })),
    ]);
    const created = [a, b].filter((r) => !r.replayed);
    const replays = [a, b].filter((r) => r.replayed);
    expect(created).toHaveLength(1);
    expect(replays).toHaveLength(1);
    expect(replays[0].runRid).toBe(created[0].runRid);

    const rows = await ctx.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM jemma_run WHERE repository_rid = $1`,
      [repositoryRid],
    );
    expect(rows.rows[0].n).toBe(1);
  }, 20_000);

  it("pre-check path: enqueue while a run is active rejects with the active run rid", async () => {
    // Park the first run's execution in setup so it is
    // deterministically still active at the second enqueue.
    let release!: () => void;
    stemma.readBlobGate = new Promise<void>((resolve) => { release = resolve; });
    const service = makeService(ctx.pool);
    try {
      const first = await service.enqueue(enqueueArgs());
      const args = enqueueArgs({ repositoryRid: first.repositoryRid, semver: "1.0.1" });
      await expect(service.enqueue(args)).rejects.toMatchObject({
        code: "RUN_ALREADY_ACTIVE",
        details: { activeRunRid: first.runRid },
      });
      await service.cancel(first.runRid);
    } finally {
      release();
      stemma.readBlobGate = null;
    }
  }, 20_000);

  it("same-semver completed-run replay remains unchanged", async () => {
    const service = makeService(ctx.pool);
    const args = enqueueArgs();
    const first = await service.enqueue(args);
    await service.cancel(first.runRid);
    // Same identity, now terminal → dedup replay, NOT a conflict.
    const again = await service.enqueue({ ...args, idempotencyKey: randomUUID() });
    expect(again.replayed).toBe(true);
    expect(again.runRid).toBe(first.runRid);
  }, 20_000);

  it("different branches enqueue independently", async () => {
    const repositoryRid = `ri.stemma.main.repository.00000000-0000-0000-0000-${randomUUID().slice(0, 12)}`;
    const service = makeService(ctx.pool);
    const main = await service.enqueue(enqueueArgs({ repositoryRid, branch: "main", semver: "1.0.0" }));
    const feature = await service.enqueue(enqueueArgs({ repositoryRid, branch: "feature", semver: "1.0.0" }));
    expect(main.replayed).toBe(false);
    expect(feature.replayed).toBe(false);
    expect(feature.runRid).not.toBe(main.runRid);
    const rows = await ctx.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM jemma_run WHERE repository_rid = $1`,
      [repositoryRid],
    );
    expect(rows.rows[0].n).toBe(2);
    await service.cancel(main.runRid);
    await service.cancel(feature.runRid);
  }, 20_000);

  it("a new run is allowed after the prior run becomes terminal", async () => {
    const repositoryRid = `ri.stemma.main.repository.00000000-0000-0000-0000-${randomUUID().slice(0, 12)}`;
    const service = makeService(ctx.pool);
    const first = await service.enqueue(enqueueArgs({ repositoryRid, semver: "1.0.0" }));
    await service.cancel(first.runRid);
    const second = await service.enqueue(enqueueArgs({ repositoryRid, semver: "1.0.1" }));
    expect(second.replayed).toBe(false);
    expect(second.runRid).not.toBe(first.runRid);
    await service.cancel(second.runRid);
  }, 20_000);
});
