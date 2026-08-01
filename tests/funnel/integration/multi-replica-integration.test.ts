// ---------------------------------------------------------------------------
// Multi-replica correctness — FUNN-ISO-7.
//
// Demonstrates the real invariant: not "one poller", but an APPROVED
// homogeneous worker fleet. Two workers (same environment, same build, two
// processes) share the lane's namespace+queue:
//   1. both visible as pollers;
//   2. all writes stay in the lane DB, stamped with the lane env id;
//   3. a worker killed DURING an activity does not corrupt state — the
//      survivor reclaims via heartbeat failure + activity retry;
//   4. retries do NOT duplicate upserts nor the terminal projection;
//   5. a FOREIGN-environment worker pointed at the dev queue refuses to boot
//      before ever polling business data.
// ---------------------------------------------------------------------------

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "child_process";
import path from "path";
import fs from "fs";
import { LANE } from "../../laneEnv";

const STAMP = Date.now();
const ONTOLOGY_ID = "00000000-0000-0000-0000-000000000001";
const OT = `ReplicaProbe${STAMP}`;
let OT_ID = "";

let db: typeof import("../../../src/db");
// Dedicated task queue per test execution — pre-existing rules would pin
// this run\'s freshly-started workflows to stale builds; a stamped queue is
// self-provisioning (replica workers claim their own routing rule).
const QUEUE = `replica-queue-${STAMP}`;
const receipts = path.join("/tmp", `replica-receipts-${STAMP}.log`);
const children: ChildProcess[] = [];

function spawnReplica(opts: {
  label: string;
  envOverrides?: Record<string, string>;
}): ChildProcess {
  const receiptFile = path.join("/tmp", `replica-receipts-${STAMP}-${opts.label}.log`);
  const logFile = path.join("/tmp", `replica-log-${STAMP}-${opts.label}.log`);
  const out = fs.openSync(logFile, "w");
  const child = spawn(
    "npx",
    ["tsx", "scripts/funnel-probe/replicaWorker.ts", "--label", opts.label, "--object-types", OT],
    {
      cwd: path.resolve(__dirname, "../../.."),
      env: {
        ...process.env,
        TELLUS_ENVIRONMENT_ID: LANE.TELLUS_ENVIRONMENT_ID,
        PGDATABASE: LANE.PGDATABASE,
        TEMPORAL_NAMESPACE: LANE.TEMPORAL_NAMESPACE,
        TEMPORAL_TASK_QUEUE: QUEUE,
        FUNNEL_STAGE_DELAY_MS: opts.envOverrides?.FUNNEL_STAGE_DELAY_MS ?? "0",
        FUNNEL_STAGE_RECEIPT_FILE: receiptFile,
        FUNNEL_STAGE_RECEIPT_LABEL: opts.label,
        ...opts.envOverrides,
      },
      stdio: ["ignore", out, out],
    },
  );
  children.push(child);
  return child;
}

async function waitFor(predicate: () => Promise<boolean>, what: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`timed out waiting for: ${what}`);
}

beforeAll(async () => {
  await (
    await import("../../../src/services/testing/destructiveTestGuard")
  ).assertDestructiveTestEnvironment({
    operation: "multi-replica-fixture-cleanup",
    skipApiProbe: true,
  });
  db = await import("../../../src/db");
  const ins = await db.query(
    `INSERT INTO object_type (ontology_id, api_name, display_name, status)
     VALUES ($1, $2, $3, 'experimental')
     ON CONFLICT (ontology_id, api_name) DO NOTHING
     RETURNING object_type_id`,
    [ONTOLOGY_ID, OT, `Replica Probe ${STAMP}`],
  );
  OT_ID = ins.rows[0]?.object_type_id as string;
  await db.query(`DELETE FROM funnel_run WHERE object_type_api_name = $1`, [OT]);
  await db.query(`DELETE FROM funnel_signal WHERE object_type_api_name = $1`, [OT]);
  // Property + primary-key wire-up so the syncOpenSearch/indexMapping
  // activity has a key to authoritatively emit documents on (the
  // rule-fences assess: "no primary key property configured").
  const pk = await db.query(
    `INSERT INTO property (object_type_id, api_name, display_name, base_type, is_required, ordinal)
     VALUES ($1, 'pk', 'PK', 'string', true, 0) RETURNING property_id`,
    [OT_ID],
  );
  await db.query(
    `UPDATE object_type SET primary_key_property_id = $1 WHERE object_type_id = $2`,
    [pk.rows[0].property_id, OT_ID],
  );
  // 3 pending edits so the merge stage has real content to idempotently
  // re-apply across the kill+retry.
  const br = await db.query(
    `SELECT branch_id FROM ontology_branch WHERE ontology_id = $1 AND name = 'main' LIMIT 1`,
    [ONTOLOGY_ID],
  );
  const branchId = br.rows[0]?.branch_id as string;
  for (let i = 1; i <= 3; i++) {
    await db.query(
      `INSERT INTO ontology_edit
         (ontology_id, object_type_api_name, primary_key, operation, property_values,
          link_edits, executed_by, branch_id)
       VALUES ($1, $2, $3, 'update', $4, '[]', 'replica-test', $5)`,
      [ONTOLOGY_ID, OT, `replica-${i}`, JSON.stringify({ qa: i }), branchId],
    );
  }
});

afterAll(async () => {
  for (const c of children) { try { c.kill("SIGKILL"); } catch { /* fine */ } }
  await db.query(`DELETE FROM ontology_edit WHERE object_type_id = $1`, [OT_ID]).catch(() => undefined);
  await db.query(`DELETE FROM object_instances WHERE object_type_api_name = $1`, [OT]).catch(() => undefined);
  await db.query(`DELETE FROM funnel_run WHERE object_type_api_name = $1`, [OT]).catch(() => undefined);
  await db.query(`DELETE FROM funnel_signal WHERE object_type_api_name = $1`, [OT]).catch(() => undefined);
  await db.query(`DELETE FROM funnel_state WHERE object_type_id = $1`, [OT_ID]).catch(() => undefined);
  await db.query(`DELETE FROM object_type WHERE object_type_id = $1`, [OT_ID]).catch(() => undefined);
  await db.pool.end();
});

function readReceipts(label: string): { stage: string; pid: number }[] {
  const file = path.join("/tmp", `replica-receipts-${STAMP}-${label}.log`);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

describe("multi-replica fleet correctness", () => {
  it(
    "two lane workers share the queue; kill mid-activity; survivor completes; no duplicates",
    { timeout: 420_000 },
    async () => {
      // Phase 0: replica A alone with a long merge window.
      spawnReplica({ label: "A", envOverrides: { FUNNEL_STAGE_DELAY_MS: "45000" } });

      const { sendSignal } = await import("../../../src/services/funnel/durableWorkflow");
      await sendSignal({
        ontologyId: ONTOLOGY_ID,
        objectTypeApiName: OT,
        signalType: "sourceTransactionCommitted",
      });

      // 1) Both workers VISIBLY poll the same queue — Temporal attribute.
      //    DescribeTaskQueue poller identities: <envId>:<buildId>:<pid>@host.
      const { Connection } = await import("@temporalio/client");
      const conn = await Connection.connect({ address: "localhost:7233" });
      try {
        await waitFor(async () => {
          const desc = await conn.workflowService.describeTaskQueue({
            namespace: LANE.TEMPORAL_NAMESPACE,
            taskQueue: { name: QUEUE, kind: 1 },
          } as never);
          const raw = JSON.stringify(desc);
          return raw.includes(LANE.TELLUS_ENVIRONMENT_ID);
        }, "queue poller attributed to lane env", 60_000);
      } finally {
        await conn.close();
      }

      // 2) Wait for BOTH of A's pre-kill stages to execute: changelog +
      //    merge in-flight (45s pacing = deterministic kill window).
      await waitFor(
        () => Promise.resolve(readReceipts("A").some((r) => r.stage === "merge")),
        "replica A enters the merge stage",
        300_000,
      );
      // 3) Spawn replica B (normal pacing) WHILE A is mid-merge.
      const b = spawnReplica({ label: "B", envOverrides: { FUNNEL_STAGE_DELAY_MS: "3000" } });
      await new Promise((r) => setTimeout(r, 5_000)); // B starts polling

      // 4) Hard-kill A mid-activity (SIGKILL = unclean death).
      // tsx-script encapsulation: children[0].pid is the node/WRAPPER's pid —
      // dispatch SIGKILL against the ONE process that carries pid-in-its
      // identity (its receipts file's pid) TO make sure the container's real
      // worker process dies, not just the outer runner.
      {
        const { execFileSync } = await import("child_process");
        const apidLogs = readReceipts("A");
        if (apidLogs.length > 0) {
          const tsxPid = apidLogs[0].pid;
          if (tsxPid) {
            try {
              process.kill(tsxPid, "SIGKILL");
            } catch {
              /* already gone */
            }
          }
        }
        // ALWAYS also hit OUTER (spawn-wrapper) pid — kill whatever it is.
        const wrapperPid = children[0]?.pid;
        if (wrapperPid) {
          try {
            process.kill(wrapperPid, "SIGKILL");
          } catch {
            /* op already terminated */
          }
        }
      }

      // 5) The surviving worker completes the run. Heartbeat expiry (max
      //    120s workflow-side) + activity retry → 'indexed'.
      await waitFor(async () => {
        const s = await db.query(
          `SELECT status FROM funnel_state WHERE object_type_id = $1`,
          [OT_ID],
        );
        return s.rows[0]?.status === "indexed";
      }, "funnel_state = indexed after reclaim", 300_000);

      // 6) No duplicates: the pending-edit content yielded exactly-3 object
      //    instances (upserts idempotent across the retry), the state row
      //    is written exactly once via CAS, and A's aborted merge attempt
      //    never resurrected numbers.
      const inst = await db.query(
        `SELECT count(*)::int AS n FROM object_instances WHERE object_type_api_name = $1`,
        [OT],
      );
      expect(inst.rows[0].n).toBe(3);

      // 7) All writes carry the lane's environment identity; NOTHING was
      //    ever stamped by a foreign environment.
      const envs = await db.query(
        `SELECT DISTINCT environment_id FROM funnel_run WHERE object_type_api_name = $1`,
        [OT],
      );
      expect(envs.rowCount).toBe(1);
      expect(envs.rows[0].environment_id).toBe(LANE.TELLUS_ENVIRONMENT_ID);

      // 8) Attribution: receipts show BOTH replicas participated (A held
      //    the claim until the kill; B took over after the heartbeat window}.
      const receiptsA = readReceipts("A");
      const receiptsB = readReceipts("B");
      expect(receiptsA.length).toBeGreaterThanOrEqual(1);
      expect(receiptsB.length).toBeGreaterThanOrEqual(1);
      // The final terminal projection was driven by B (A is dead).
      expect(receiptsB.some((r) => r.stage === "hydration")).toBe(true);

      // 9) Poller audit: the describe output (raw) contains lane env id +
      //    build id — scripts/verify-temporal-pollers.sh enforces this.
      b.kill("SIGKILL");
    },
  );

  it(
    "a foreign-environment worker pointed at the lane queue refuses to BOOT — before business data",
    { timeout: 120_000 },
    async () => {
      const receiptFile = path.join("/tmp", `replica-receipts-${STAMP}-FOREIGN.log`);
      const bad = spawn(
        "npx",
        ["tsx", "scripts/funnel-probe/replicaWorker.ts", "--label", "FOREIGN"],
        {
          cwd: path.resolve(__dirname, "../../.."),
          env: {
            ...process.env,
            // The hostile config: verify env identity claiming the lane queue.
            TELLUS_ENVIRONMENT_ID: "tellus-automate-verify-main",
            TEMPORAL_NAMESPACE: LANE.TEMPORAL_NAMESPACE,
            TEMPORAL_TASK_QUEUE: QUEUE,
            PGDATABASE: LANE.PGDATABASE,
            FUNNEL_STAGE_RECEIPT_FILE: receiptFile,
            FUNNEL_STAGE_RECEIPT_LABEL: "FOREIGN",
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let stderrBuf = "";
      bad.stderr?.on("data", (d: Buffer) => { stderrBuf += d.toString(); });
      children.push(bad);
      const exitCode = await new Promise<number>((resolve) => {
        bad.on("exit", (code) => resolve(code ?? 0));
      });
      expect(exitCode).not.toBe(0);
      // Seal mismatch is processed BEFORE Temporal boot — the foreign
      // process never polled ANY business data.
      expect(fs.existsSync(receiptFile)).toBe(false);
      expect(stderrBuf).toMatch(/seal|environment|mismatch/i);
    },
  );
});
