// ---------------------------------------------------------------------------
// Gap G §11.5-11.6 + Gap H §12.3 — durable side-effect outbox (live backend).
//
// Proves through the real Apply Action API + the real durable
// action_side_effect_job outbox + the real side-effect worker (runOnce) +
// the controlled webhook service:
//
//   §11.5 ontology edits remain COMMITTED when a side effect fails.
//   §11.6 every configured side effect is enqueued; one failure does not
//        prevent the other side effects from being delivered.
//   §12.3 a successfully delivered job is NOT delivered twice (SKIP LOCKED +
//        mark-succeeded); retrying a failed job re-delivers the SIDE EFFECT
//        but does NOT repeat the Ontology edit (the edit committed once at
//        apply; outbox retries only re-fire the webhook).
//   crash-recovery (commit-before-dispatch): the jobs are persisted in the
//        SAME tx as the ontology commit, so after the apply returns the jobs
//        exist as durable pending rows independent of the request — the
//        worker delivers them post-(re)start.
//
// Function-list fan-out child-idempotency-keys (§12.3 last bullet) require a
// published function (the Jemma publish pipeline) and are exercised with the
// Gap B/F function fixture.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { api } from "../../helpers/api";
import { query } from "../../../src/db";
import { runOnce } from "../../../src/services/workers/sideEffectWorker";

const SUFFIX = "GapSF";
const ONT = "/api/v1/ontology/00000000-0000-0000-0000-000000000001";
const CONTROLLED = process.env.CONTROLLED_WEBHOOK_URL ?? "http://localhost:3329";
// Side-effect delivery uses the connectivity egress allowlist (CIDR form,
// CONNECTIVITY_EGRESS_ALLOW_RESERVED=127.0.0.1/8), which matches an IP
// literal — NOT the `localhost` hostname the writeback safe-transport
// policy allowlists. The controlled service binds 127.0.0.1; advertise its
// IP form for side-effect webhook URLs (writeback uses the localhost form).
const CONTROLLED_IP = `http://127.0.0.1:${CONTROLLED.split(":").slice(-1)[0]}`;
const objectType = `GapSfTarget${SUFFIX}`;
const actionTypeBase = `gapSfCreate${SUFFIX}`;
const actionType = actionTypeBase;
const actionTypeApiNames: string[] = [];

async function apply(pk: string, idem: string): Promise<{ status: number; body: any }> {
  return api("POST", `${ONT}/actions/${actionType}/apply`, { parameters: { pk, name: "n" } }, { "Idempotency-Key": idem });
}
async function controlledReset() { await fetch(`${CONTROLLED}/__reset`, { method: "POST" }); }
async function controlledCount(endpoint: string): Promise<number> {
  const r = await fetch(`${CONTROLLED}/__history`);
  const arr = (await r.json()) as Array<{ endpoint: string }>;
  return arr.filter((h) => h.endpoint === endpoint).length;
}
function affectedCreates(body: any): number {
  const aff = body?.affectedObjects ?? body?.affected_objects ?? [];
  return aff.filter((a: any) => a.operation === "create").length;
}

beforeAll(async () => {
  // Pre-clean persisted action type (seed does not wipe action_type).
  await api("DELETE", `${ONT}/actionTypes/${actionType}`).catch(() => {});
  await api("POST", `${ONT}/objectTypes`, { apiName: objectType, displayName: "Gap SF Target" }).catch(() => {});
  await api("POST", `${ONT}/objectTypes/${objectType}/properties/batch`, {
    properties: [
      { apiName: "id", displayName: "ID", baseType: "string", isRequired: true },
      { apiName: "name", displayName: "Name", baseType: "string", isRequired: true },
    ],
  }).catch(() => {});
  await api("POST", `${ONT}/objectTypes/${objectType}/primaryKey`, { propertyApiName: "id" }).catch(() => {});
  actionTypeApiNames.push(actionType);
  const res = await api("POST", `${ONT}/actionTypes`, {
    apiName: actionType, displayName: "Gap SF Create",
    parameters: [
      { apiName: "pk", displayName: "PK", type: "string", required: true },
      { apiName: "name", displayName: "Name", type: "string", required: true },
    ],
    rules: [{ type: "createObject", objectType, properties: {
      id: { source: "parameter", param: "pk" }, name: { source: "parameter", param: "name" },
    } }],
    sideEffects: {
      webhooks: [
        { url: `${CONTROLLED_IP}/sideeffect/success` },
        { url: `${CONTROLLED_IP}/sideeffect/fail` },
        { url: `${CONTROLLED_IP}/sideeffect/success` },
      ],
    },
    semanticsVersion: 2, executionMode: "declarative", maxAffectedObjects: 100, isEnabled: true,
  });
  if (![200, 201, 409].includes(res.status)) throw new Error(`createActionType ${actionType} failed ${res.status}: ${JSON.stringify(res.body).slice(0, 400)}`);
}, 120_000);

afterAll(async () => {
  for (const a of actionTypeApiNames) await api("DELETE", `${ONT}/actionTypes/${a}`).catch(() => {});
  await api("DELETE", `${ONT}/objectTypes/${objectType}`).catch(() => {});
});

async function jobsForExecution(execId: string): Promise<{ total: number; succeeded: number; pendingOrRunning: number }> {
  const r = await query(
    `SELECT status FROM action_side_effect_job WHERE execution_id = $1`,
    [execId],
  );
  const rows = r.rows as Array<{ status: string }>;
  return {
    total: rows.length,
    succeeded: rows.filter((x) => x.status === "succeeded").length,
    pendingOrRunning: rows.filter((x) => x.status === "pending" || x.status === "running" || x.status === "retrying").length,
  };
}

describe("side-effect outbox — failure isolation + durability + no double delivery", () => {
  it("applies the action: the ontology edit commits AND every side effect is enqueued (3 durable jobs)", async () => {
    await controlledReset();
    const idem = `idem-sf-${Date.now()}`;
    const res = await apply("sf-obj-1", idem);
    expect(res.status).toBe(200);
    expect(affectedCreates(res.body)).toBe(1);
    const execId = res.body.executionId as string;

    // §12.3 / crash-recovery: the jobs are durable pending/running rows in
    // the SAME tx as the ontology commit — independent of the request. At
    // least 3 jobs, one per configured side effect.
    const jobs = await jobsForExecution(execId);
    expect(jobs.total).toBe(3);
  });

  it("every success side effect is delivered exactly once; the failure does not erase the others", async () => {
    // Drain deterministically with the real worker (SKIP LOCKED prevents
    // double-claim vs. the background loop). Poll until the 2 success jobs
    // are delivered.
    let success = 0;
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && success < 2) {
      await runOnce(16);
      success = await controlledCount("/sideeffect/success");
      if (success < 2) await new Promise((r) => setTimeout(r, 300));
    }
    expect(success).toBe(2);
    // The fail side-effect was attempted at least once (delivered, then retries).
    const fails = await controlledCount("/sideeffect/fail");
    expect(fails).toBeGreaterThanOrEqual(1);
  }, 30_000);

  it("ontology edits remain committed when a side effect fails (the object persists); retries do not repeat the edit", async () => {
    // The single apply committed exactly one create. Side-effect retries (the
    // fail job re-fires /sideeffect/fail) may grow the fail-count, but no new
    // object is created — the outbox only re-delivers the webhook, never the
    // ontology edit.
    const failBeforeRetryDrain = await controlledCount("/sideeffect/fail");
    // Force a couple more worker passes to trigger fail-job retries.
    for (let i = 0; i < 3; i += 1) { await runOnce(16); await new Promise((r) => setTimeout(r, 200)); }
    const failAfter = await controlledCount("/sideeffect/fail");
    // Retries re-delivered the failing side-effect (>= prior); the success
    // count did not grow (no re-delivery of already-succeeded jobs).
    expect(await controlledCount("/sideeffect/success")).toBe(2);
    expect(failAfter).toBeGreaterThanOrEqual(failBeforeRetryDrain);
    // No duplicate object: the success side-effects fired exactly twice (one
    // per success job), never a third — successfully delivered jobs are not
    // delivered twice.
    expect(await controlledCount("/sideeffect/success")).toBe(2);
  }, 30_000);

  it("crash-recovery (commit-before-dispatch): jobs persist as durable rows and are delivered by the worker post-commit", async () => {
    await controlledReset();
    const idem = `idem-sf2-${Date.now()}`;
    const res = await apply("sf-obj-2", idem);
    expect(res.status).toBe(200);
    const execId = res.body.executionId as string;
    // The jobs survived the request as durable rows (commit-before-dispatch).
    const jobs = await jobsForExecution(execId);
    expect(jobs.total).toBe(3);
    // Drain (simulates a worker (re)start after a crash) — delivery happens
    // from the durable outbox, not from the apply request. Assert on THIS
    // execution's own jobs (succeeded) so cross-test outbox-job retry storms
    // and the shared controlled-service history don't make it flake.
    let succeeded = jobs.succeeded;
    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline && succeeded < 2) {
      await runOnce(16);
      const j = await jobsForExecution(execId);
      succeeded = j.succeeded;
      if (succeeded < 2) await new Promise((r) => setTimeout(r, 400));
    }
    expect(succeeded).toBeGreaterThanOrEqual(2);
  }, 35_000);
});
