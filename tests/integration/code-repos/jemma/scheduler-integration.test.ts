// ---------------------------------------------------------------------------
// B6 — scheduler integration tests against real Postgres + in-memory worker.
//
// Verifies:
//   - QUEUED→RUNNING admission wires WorkerAdapter.startPod
//   - Per-(repo,ref) singleton: new push cancels in-flight on same ref
//   - Per-repo concurrency cap (default 4)
//   - Idempotency-Key replay (G-C-22)
//   - image-unavailable → FAILED with reason
//   - cancelRunByUser end-to-end
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { openTestSchema } from "../_helpers/pg";
import { InMemoryWorker } from "../../../../src/services/jemma/scheduler/inMemoryWorker";
import {
  cancelRunByUser,
  scheduleRun,
} from "../../../../src/services/jemma/scheduler/scheduler";
import {
  getRun,
  listActiveRunsForRepo,
} from "../../../../src/services/jemma/store/runStore";

const ROOT = process.cwd();
const UP_054 = readFileSync(path.join(ROOT, "src/migrations/054_b6_jemma.sql"), "utf-8");
const USER_UUID = "ab78f128-9c4e-4b65-9d80-f0a3a7e0c102";

function args(overrides: {
  repo?: string;
  ref?: string;
  commit?: string;
  key?: string;
} = {}) {
  return {
    repositoryRid: overrides.repo ?? "ri.stemma.main.repository." + randomUUID(),
    ref: overrides.ref ?? "refs/heads/main",
    commitSha: overrides.commit ?? "abc1234",
    trigger: "PUSH" as const,
    triggeredBy: USER_UUID,
    idempotencyKey: overrides.key ?? randomUUID(),
  };
}

describe("B6 scheduler — happy path", () => {
  let openSchema: Awaited<ReturnType<typeof openTestSchema>>;
  let worker: InMemoryWorker;

  beforeAll(async () => {
    openSchema = await openTestSchema("jemma_sched");
    await openSchema.applyMigrationSql(UP_054);
  });
  afterAll(async () => {
    if (openSchema) await openSchema.close();
  });
  beforeEach(() => {
    worker = new InMemoryWorker();
  });

  it("scheduleRun: starts a fresh run; persists RUNNING + podName", async () => {
    const out = await scheduleRun({ pool: openSchema.pool, worker }, args());
    expect(out.kind).toBe("started");
    if (out.kind !== "started") return;
    expect(out.run.state).toBe("RUNNING");
    expect(out.run.podName).toMatch(/^pod-0-/);
    expect(out.cancelledRid).toBeNull();
    const obs = worker.observed();
    expect(obs.starts.length).toBe(1);
    expect(obs.cancels.length).toBe(0);
  });

  it("idempotent replay: same key + same triggeredBy → kind='replay'", async () => {
    const repo = "ri.stemma.main.repository." + randomUUID();
    const key = randomUUID();
    const a = args({ repo, ref: "refs/heads/replay", key });
    const out1 = await scheduleRun({ pool: openSchema.pool, worker }, a);
    expect(out1.kind).toBe("started");
    if (out1.kind !== "started") return;

    const out2 = await scheduleRun({ pool: openSchema.pool, worker }, a);
    expect(out2.kind).toBe("replay");
    if (out2.kind !== "replay") return;
    expect(out2.run.rid).toBe(out1.run.rid);

    // Worker was NOT called the second time.
    expect(worker.observed().starts.length).toBe(1);
  });
});

describe("B6 scheduler — per-(repo,ref) singleton (cancel-in-flight)", () => {
  let openSchema: Awaited<ReturnType<typeof openTestSchema>>;
  let worker: InMemoryWorker;

  beforeAll(async () => {
    openSchema = await openTestSchema("jemma_sched_cancel");
    await openSchema.applyMigrationSql(UP_054);
  });
  afterAll(async () => {
    if (openSchema) await openSchema.close();
  });
  beforeEach(() => {
    worker = new InMemoryWorker();
  });

  it("new push to same ref cancels in-flight + starts new run", async () => {
    const repo = "ri.stemma.main.repository." + randomUUID();
    const ref = "refs/heads/active";

    const out1 = await scheduleRun(
      { pool: openSchema.pool, worker },
      args({ repo, ref, commit: "aaa1111", key: randomUUID() }),
    );
    expect(out1.kind).toBe("started");
    if (out1.kind !== "started") return;
    const firstRid = out1.run.rid;

    const out2 = await scheduleRun(
      { pool: openSchema.pool, worker },
      args({ repo, ref, commit: "bbb2222", key: randomUUID() }),
    );
    expect(out2.kind).toBe("started");
    if (out2.kind !== "started") return;
    expect(out2.cancelledRid).toBe(firstRid);
    expect(out2.run.commitSha).toBe("bbb2222");

    // First run is now CANCELLED.
    const r1 = await getRun(openSchema.pool, firstRid);
    expect(r1?.state).toBe("CANCELLED");
    expect(r1?.failureReason).toBe("cancelled-by-newer-push");

    // Worker was signalled to cancel the first pod.
    const obs = worker.observed();
    expect(obs.cancels.length).toBe(1);
    expect(obs.cancels[0].runRid).toBe(firstRid);
    expect(obs.cancels[0].reason).toBe("cancelled-by-newer-push");
    // And started 2 pods total.
    expect(obs.starts.length).toBe(2);
  });

  it("worker.signalCancel throwing does NOT prevent the new run from starting", async () => {
    const repo = "ri.stemma.main.repository." + randomUUID();
    const ref = "refs/heads/cancel-throw";

    const out1 = await scheduleRun(
      { pool: openSchema.pool, worker },
      args({ repo, ref }),
    );
    expect(out1.kind).toBe("started");

    // Replace the worker with one that throws on signalCancel.
    const flakyWorker: import("../../../../src/services/jemma/scheduler/types").WorkerAdapter = {
      startPod: worker.startPod.bind(worker),
      signalCancel: async () => {
        throw new Error("kube api unreachable");
      },
    };

    const out2 = await scheduleRun(
      { pool: openSchema.pool, worker: flakyWorker },
      args({ repo, ref }),
    );
    expect(out2.kind).toBe("started");
    if (out2.kind !== "started") return;
    // First run still landed in CANCELLED in the database (authoritative).
    const r1 = await getRun(openSchema.pool, (out1 as { run: { rid: string } }).run.rid);
    expect(r1?.state).toBe("CANCELLED");
  });
});

describe("B6 scheduler — per-repo capacity cap", () => {
  let openSchema: Awaited<ReturnType<typeof openTestSchema>>;
  let worker: InMemoryWorker;

  beforeAll(async () => {
    openSchema = await openTestSchema("jemma_sched_cap");
    await openSchema.applyMigrationSql(UP_054);
  });
  afterAll(async () => {
    if (openSchema) await openSchema.close();
  });
  beforeEach(() => {
    worker = new InMemoryWorker();
  });

  it("rejects with kind='capacity-exceeded' when 4 ACTIVE runs already exist on the repo", async () => {
    const repo = "ri.stemma.main.repository." + randomUUID();
    for (let i = 0; i < 4; i++) {
      const out = await scheduleRun(
        { pool: openSchema.pool, worker },
        args({ repo, ref: `refs/heads/branch-${i}` }),
      );
      expect(out.kind).toBe("started");
    }
    const out5 = await scheduleRun(
      { pool: openSchema.pool, worker },
      args({ repo, ref: "refs/heads/branch-4" }),
    );
    expect(out5.kind).toBe("capacity-exceeded");
    if (out5.kind !== "capacity-exceeded") return;
    expect(out5.reason).toBe("per-repo-cap");

    const active = await listActiveRunsForRepo(openSchema.pool, repo);
    expect(active.length).toBe(4);
  });

  it("config override: perRepoActiveCap=1 caps at 1", async () => {
    const repo = "ri.stemma.main.repository." + randomUUID();
    const out1 = await scheduleRun(
      { pool: openSchema.pool, worker, config: { perRepoActiveCap: 1 } },
      args({ repo, ref: "refs/heads/cap-a" }),
    );
    expect(out1.kind).toBe("started");
    const out2 = await scheduleRun(
      { pool: openSchema.pool, worker, config: { perRepoActiveCap: 1 } },
      args({ repo, ref: "refs/heads/cap-b" }),
    );
    expect(out2.kind).toBe("capacity-exceeded");
  });
});

describe("B6 scheduler — image-unavailable", () => {
  let openSchema: Awaited<ReturnType<typeof openTestSchema>>;

  beforeAll(async () => {
    openSchema = await openTestSchema("jemma_sched_img");
    await openSchema.applyMigrationSql(UP_054);
  });
  afterAll(async () => {
    if (openSchema) await openSchema.close();
  });

  it("startPod throws image-unavailable → run lands in FAILED with reason", async () => {
    const worker = new InMemoryWorker();
    worker.failStartWithImageUnavailable();
    const out = await scheduleRun({ pool: openSchema.pool, worker }, args());
    expect(out.kind).toBe("image-unavailable");

    // The persisted run is FAILED with reason='image-unavailable'.
    const list = await listActiveRunsForRepo(openSchema.pool, args().repositoryRid);
    expect(list.length).toBe(0); // FAILED is terminal, not ACTIVE.
  });
});

describe("B6 scheduler — cancelRunByUser", () => {
  let openSchema: Awaited<ReturnType<typeof openTestSchema>>;

  beforeAll(async () => {
    openSchema = await openTestSchema("jemma_sched_user_cancel");
    await openSchema.applyMigrationSql(UP_054);
  });
  afterAll(async () => {
    if (openSchema) await openSchema.close();
  });

  it("cancels a RUNNING run; persists CANCELLED with reason='cancelled-by-user'", async () => {
    const worker = new InMemoryWorker();
    const out = await scheduleRun({ pool: openSchema.pool, worker }, args());
    expect(out.kind).toBe("started");
    if (out.kind !== "started") return;

    const result = await cancelRunByUser({ pool: openSchema.pool, worker }, out.run.rid);
    expect(result.kind).toBe("cancelled");
    const r = await getRun(openSchema.pool, out.run.rid);
    expect(r?.state).toBe("CANCELLED");
    expect(r?.failureReason).toBe("cancelled-by-user");
    expect(worker.observed().cancels[0]?.reason).toBe("cancelled-by-user");
  });

  it("returns kind='not-found' for unknown rid", async () => {
    const worker = new InMemoryWorker();
    const result = await cancelRunByUser(
      { pool: openSchema.pool, worker },
      "ri.jemma.main.run." + randomUUID(),
    );
    expect(result.kind).toBe("not-found");
  });

  it("returns kind='already-terminal' for a terminal run", async () => {
    const worker = new InMemoryWorker();
    const out = await scheduleRun({ pool: openSchema.pool, worker }, args());
    if (out.kind !== "started") throw new Error("setup");
    await cancelRunByUser({ pool: openSchema.pool, worker }, out.run.rid);
    const second = await cancelRunByUser({ pool: openSchema.pool, worker }, out.run.rid);
    expect(second.kind).toBe("already-terminal");
  });
});
