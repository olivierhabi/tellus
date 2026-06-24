// ---------------------------------------------------------------------------
// B6 — run store integration tests against real Postgres.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { openTestSchema } from "../_helpers/pg";
import {
  RunStoreError,
  findRunByIdempotencyKey,
  getActiveRunForRef,
  getRun,
  getRunStages,
  insertRun,
  listActiveRunsForRepo,
  rebuildRunContext,
  transitionRunWithinTx,
} from "../../../../src/services/jemma/store/runStore";
import { transition } from "../../../../src/services/jemma/state/stateMachine";

const ROOT = process.cwd();
const UP_054 = readFileSync(path.join(ROOT, "src/migrations/054_b6_jemma.sql"), "utf-8");

const REPO_RID = "ri.stemma.main.repository." + randomUUID();
const USER_UUID = "ab78f128-9c4e-4b65-9d80-f0a3a7e0c102";
const T0 = "2026-05-01T00:00:00.000Z";

function makeArgs(extras: { ref?: string; commit?: string; key?: string | null } = {}) {
  return {
    rid: "ri.jemma.main.run." + randomUUID(),
    repositoryRid: REPO_RID,
    ref: extras.ref ?? "refs/heads/main",
    commitSha: extras.commit ?? "abc1234",
    trigger: "PUSH" as const,
    triggeredBy: USER_UUID,
    idempotencyKey: extras.key === undefined ? randomUUID() : extras.key,
  };
}

describe("B6 run store — insertRun + getRun + stages", () => {
  let openSchema: Awaited<ReturnType<typeof openTestSchema>>;

  beforeAll(async () => {
    openSchema = await openTestSchema("jemma_run_store");
    await openSchema.applyMigrationSql(UP_054);
  });
  afterAll(async () => {
    if (openSchema) await openSchema.close();
  });

  it("creates a QUEUED run + 5 PENDING stage rows in one transaction", async () => {
    const args = makeArgs();
    const run = await insertRun(openSchema.pool, args);
    expect(run.state).toBe("QUEUED");
    expect(run.podName).toBeNull();
    expect(run.startedAt).toBeNull();
    expect(run.finishedAt).toBeNull();

    const stages = await getRunStages(openSchema.pool, args.rid);
    expect(stages.length).toBe(5);
    expect(stages.map((s) => s.stageName)).toEqual([
      "setup",
      "lint",
      "test",
      "build",
      "publish",
    ]);
    expect(stages.every((s) => s.state === "PENDING")).toBe(true);
  });

  it("rejects insertion of a duplicate rid with DUPLICATE_RUN_RID", async () => {
    // Insert with a unique ref, then mark TERMINAL so the partial UQ no
    // longer applies; a second insert with the same RID then hits the PK
    // violation rather than the partial UQ.
    const dupRef = `refs/heads/dup-${randomUUID().slice(0, 8)}`;
    const a = makeArgs({ ref: dupRef });
    await insertRun(openSchema.pool, a);
    await openSchema.query(
      `UPDATE jemma_run SET state='SUCCEEDED',
         started_at=now(), finished_at=now() WHERE rid = $1`,
      [a.rid],
    );
    try {
      await insertRun(openSchema.pool, a);
      throw new Error("should have rejected");
    } catch (e) {
      expect(e).toBeInstanceOf(RunStoreError);
      expect((e as RunStoreError).code).toBe("DUPLICATE_RUN_RID");
    }
  });

  it("rejects 2 ACTIVE runs on the same (repo,ref) with ACTIVE_RUN_EXISTS_FOR_REF", async () => {
    const ref = `refs/heads/active-${randomUUID().slice(0, 8)}`;
    await insertRun(openSchema.pool, makeArgs({ ref }));
    try {
      await insertRun(openSchema.pool, makeArgs({ ref }));
      throw new Error("should have rejected");
    } catch (e) {
      expect(e).toBeInstanceOf(RunStoreError);
      expect((e as RunStoreError).code).toBe("ACTIVE_RUN_EXISTS_FOR_REF");
    }
  });

  it("getRun returns null for unknown rid", async () => {
    const r = await getRun(openSchema.pool, "ri.jemma.main.run." + randomUUID());
    expect(r).toBeNull();
  });

  it("listActiveRunsForRepo returns all QUEUED+RUNNING runs for the repo", async () => {
    const repo = "ri.stemma.main.repository." + randomUUID();
    const a = makeArgs({ ref: "refs/heads/list-a" });
    a.repositoryRid = repo;
    const b = makeArgs({ ref: "refs/heads/list-b" });
    b.repositoryRid = repo;
    await insertRun(openSchema.pool, a);
    await insertRun(openSchema.pool, b);
    const list = await listActiveRunsForRepo(openSchema.pool, repo);
    expect(list.length).toBe(2);
    expect(list.every((r) => r.state === "QUEUED")).toBe(true);
  });

  it("getActiveRunForRef returns the in-flight run, null when none", async () => {
    const ref = `refs/heads/inflight-${randomUUID().slice(0, 8)}`;
    expect(await getActiveRunForRef(openSchema.pool, REPO_RID, ref)).toBeNull();
    const args = makeArgs({ ref });
    await insertRun(openSchema.pool, args);
    const r = await getActiveRunForRef(openSchema.pool, REPO_RID, ref);
    expect(r?.rid).toBe(args.rid);
  });

  it("findRunByIdempotencyKey returns the existing run", async () => {
    const key = randomUUID();
    const args = makeArgs({ ref: "refs/heads/idem-" + randomUUID().slice(0, 6), key });
    await insertRun(openSchema.pool, args);
    const r = await findRunByIdempotencyKey(openSchema.pool, key, USER_UUID);
    expect(r?.rid).toBe(args.rid);
    // Different triggeredBy → null even with same key.
    const r2 = await findRunByIdempotencyKey(
      openSchema.pool,
      key,
      "00000000-0000-4000-8000-000000000099",
    );
    expect(r2).toBeNull();
  });

  it("transitionRunWithinTx flushes a state-machine transition", async () => {
    const args = makeArgs({ ref: "refs/heads/trans-" + randomUUID().slice(0, 6) });
    await insertRun(openSchema.pool, args);

    // QUEUED → RUNNING.
    const built = await rebuildRunContext(openSchema.pool, args.rid);
    expect(built).not.toBeNull();
    const next = transition(built!.ctx, {
      kind: "scheduler-picked",
      podName: "pod-test",
      nowIso: T0,
    });
    await openSchema.withTx(async (client) => {
      await transitionRunWithinTx(client, args.rid, next.nextContext);
    });
    const after = await getRun(openSchema.pool, args.rid);
    expect(after?.state).toBe("RUNNING");
    expect(after?.podName).toBe("pod-test");
    expect(after?.startedAt).toBeInstanceOf(Date);
    expect(after?.resourceVersion).toBe(2);
  });

  it("rebuildRunContext composes a usable RunContext from row+stages", async () => {
    const args = makeArgs({ ref: "refs/heads/rebuild-" + randomUUID().slice(0, 6) });
    await insertRun(openSchema.pool, args);
    const built = await rebuildRunContext(openSchema.pool, args.rid);
    expect(built).not.toBeNull();
    expect(built!.ctx.state).toBe("QUEUED");
    expect(built!.ctx.stages.length).toBe(5);
    expect(built!.ctx.stages.every((s) => s.state === "PENDING")).toBe(true);
    expect(built!.ctx.queuedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
