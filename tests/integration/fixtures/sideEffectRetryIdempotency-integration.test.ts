// ---------------------------------------------------------------------------
// Gap: controlled retry / idempotency — proven END-TO-END (live backend).
//
// The prior continuation report flagged: "Controlled retry/idempotency not
// proven end-to-end." This suite closes it through the real Apply Action
// API + the real durable action_side_effect_job outbox + the real worker
// (runOnce) + the real HTTP transport (deliverOneWebhook) + the controlled
// webhook service:
//
//   1. STABLE KEY ACROSS RETRIES — every delivery attempt of the SAME job
//      carries the SAME X-Idempotency-Key (the job row's idempotency_key,
//      seeded `${executionId}:wb:${sideEffectIndex}` by the extractor),
//      so a dedup-aware receiver collapses at-least-once delivery into
//      exactly-once effect.
//   2. RECEIVER-SIDE DEDUP — the controlled service's `duplicate` behavior
//      acknowledges the second delivery of a key as `deduplicated: true`
//      (transport-level proof the header propagates over real HTTP).
//   3. TIMEOUT -> RETRY -> DEAD-LETTER — a webhook whose receiver never
//      responds is aborted by the spec's timeoutMs, retried by the worker,
//      and eventually parked in the dead queue (next_attempt_at NULL) —
//      never silently lost, never infinitely retried.
//
// Complements sideEffectOutbox-integration.test.ts (which proved exactly-once
// for SUCCEEDED jobs + failure isolation); this suite proves the RETRY path.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { api } from "../../helpers/api";
import { query } from "../../../src/db";
import { runOnce } from "../../../src/services/workers/sideEffectWorker";
import { deliverOneWebhook } from "../../../src/actions/actionWebhooks";

const SUFFIX = "GapRI";
const ONT = "/api/v1/ontology/00000000-0000-0000-0000-000000000001";
const CONTROLLED = process.env.CONTROLLED_WEBHOOK_URL ?? "http://localhost:3329";
// Side-effect delivery uses the connectivity egress allowlist (CIDR form,
// CONNECTIVITY_EGRESS_ALLOW_RESERVED=127.0.0.1/8), which matches an IP
// literal — NOT the `localhost` hostname. (Same convention as
// sideEffectOutbox-integration.test.ts.)
const CONTROLLED_IP = `http://127.0.0.1:${CONTROLLED.split(":").slice(-1)[0]}`;

const objectType = `GapRiTarget${SUFFIX}`;
const failAction = `gapRiFail${SUFFIX}`;
const timeoutAction = `gapRiTimeout${SUFFIX}`;

// Fast deterministic retry policy for the test-driven worker passes: the
// suite must not wait on the production 1s..60s backoff schedule.
const FAST_POLICY = {
  maxAttempts: 3,
  initialBackoffMs: 50,
  maxBackoffMs: 100,
  multiplier: 2,
  jitterMs: 0,
};

interface HistoryEntry {
  endpoint: string;
  responseStatus: number;
  idempotencyKey: string | null;
  duplicate: boolean;
}

async function controlledReset() {
  await fetch(`${CONTROLLED}/__reset`, { method: "POST" });
}
async function controlledHistory(): Promise<HistoryEntry[]> {
  const r = await fetch(`${CONTROLLED}/__history`);
  return (await r.json()) as HistoryEntry[];
}

async function apply(actionType: string, pk: string, idem: string) {
  return api(
    "POST",
    `${ONT}/actions/${actionType}/apply`,
    { parameters: { pk, name: "n" } },
    { "Idempotency-Key": idem },
  );
}

async function jobRow(execId: string): Promise<{
  status: string;
  attempt_count: number;
  next_attempt_at: string | null;
  last_error_code: string | null;
} | null> {
  const r = await query(
    `SELECT status, attempt_count, next_attempt_at, last_error_code
       FROM action_side_effect_job WHERE execution_id = $1 ORDER BY side_effect_index LIMIT 1`,
    [execId],
  );
  return (r.rows[0] as never) ?? null;
}

/** Drain the outbox for one execution until its job reaches `dead`. */
async function drainUntilDead(execId: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await runOnce(16, FAST_POLICY);
    const row = await jobRow(execId);
    if (row?.status === "dead") return;
    if (Date.now() > deadline) {
      throw new Error(`job for ${execId} did not reach 'dead' (status=${row?.status})`);
    }
    await new Promise((r) => setTimeout(r, 120));
  }
}

beforeAll(async () => {
  await api("DELETE", `${ONT}/actionTypes/${failAction}`).catch(() => {});
  await api("DELETE", `${ONT}/actionTypes/${timeoutAction}`).catch(() => {});
  await api("POST", `${ONT}/objectTypes`, { apiName: objectType, displayName: "Gap RI Target" }).catch(() => {});
  await api("POST", `${ONT}/objectTypes/${objectType}/properties/batch`, {
    properties: [
      { apiName: "id", displayName: "ID", baseType: "string", isRequired: true },
      { apiName: "name", displayName: "Name", baseType: "string", isRequired: true },
    ],
  }).catch(() => {});
  await api("POST", `${ONT}/objectTypes/${objectType}/primaryKey`, { propertyApiName: "id" }).catch(() => {});

  const mk = (
    apiName: string,
    displayName: string,
    webhook: Record<string, unknown>,
  ) =>
    api("POST", `${ONT}/actionTypes`, {
      apiName,
      displayName,
      parameters: [
        { apiName: "pk", displayName: "PK", type: "string", required: true },
        { apiName: "name", displayName: "Name", type: "string", required: true },
      ],
      rules: [
        {
          type: "createObject",
          objectType,
          properties: {
            id: { source: "parameter", param: "pk" },
            name: { source: "parameter", param: "name" },
          },
        },
      ],
      sideEffects: { webhooks: [webhook] },
      semanticsVersion: 2,
      executionMode: "declarative",
      maxAffectedObjects: 100,
      isEnabled: true,
    });

  const r1 = await mk(failAction, "Gap RI Fail", { url: `${CONTROLLED_IP}/sideeffect/fail` });
  if (![200, 201, 409].includes(r1.status)) {
    throw new Error(`createActionType ${failAction} failed ${r1.status}: ${JSON.stringify(r1.body).slice(0, 400)}`);
  }
  const r2 = await mk(timeoutAction, "Gap RI Timeout", {
    url: `${CONTROLLED_IP}/writeback/timeout`,
    timeoutMs: 500,
  });
  if (![200, 201, 409].includes(r2.status)) {
    throw new Error(`createActionType ${timeoutAction} failed ${r2.status}: ${JSON.stringify(r2.body).slice(0, 400)}`);
  }
}, 120_000);

afterAll(async () => {
  await api("DELETE", `${ONT}/actionTypes/${failAction}`).catch(() => {});
  await api("DELETE", `${ONT}/actionTypes/${timeoutAction}`).catch(() => {});
  await api("DELETE", `${ONT}/objectTypes/${objectType}`).catch(() => {});
});

describe("side-effect retry + idempotency — end-to-end (live outbox + worker + controlled service)", () => {
  it("1. failing delivery retries with the SAME idempotency key and ends dead-lettered", async () => {
    await controlledReset();
    const res = await apply(failAction, `ri-obj-${Date.now()}`, `idem-ri-${Date.now()}`);
    expect(res.status).toBe(200);
    const execId = res.body.executionId as string;
    // The extractor seeds webhook job keys as `${executionId}:wb:${i}`
    // (sideEffectJobExtractor.idempotencySeed); the worker sends the job
    // row's idempotency_key verbatim on every delivery attempt.
    const expectedKey = `${execId}:wb:0`;

    // Retries happen (fail behavior always 502s) until the policy exhausts.
    await drainUntilDead(execId);

    // Dead-letter terminal state: parked, never silently lost, never
    // infinitely retried.
    const row = await jobRow(execId);
    expect(row).not.toBeNull();
    expect(row!.status).toBe("dead");
    expect(row!.next_attempt_at).toBeNull();
    expect(row!.attempt_count).toBeGreaterThanOrEqual(2); // retried at least once
    expect(row!.last_error_code).toBeTruthy();

    // STABLE KEY: every delivery attempt of this job carried the SAME
    // X-Idempotency-Key — a dedup-aware receiver can collapse them.
    const history = await controlledHistory();
    const attempts = history.filter(
      (h) => h.endpoint === "/sideeffect/fail" && h.idempotencyKey?.startsWith(execId),
    );
    expect(attempts.length).toBeGreaterThanOrEqual(2); // initial + >=1 retry
    for (const a of attempts) {
      expect(a.idempotencyKey).toBe(expectedKey);
    }
  }, 45_000);

  it("2. receiver-side dedup: a repeated X-Idempotency-Key is acknowledged as deduplicated", async () => {
    await controlledReset();
    const key = `e2e-dedup-${Date.now()}`;
    const spec = {
      url: `${CONTROLLED_IP}/sideeffect/duplicate`,
      method: "POST",
      headers: {},
      timeoutMs: 2_000,
    };
    const payload = {
      executionId: key,
      actionTypeApiName: failAction,
      ontologyId: "00000000-0000-0000-0000-000000000001",
      branchId: null,
      result: "success",
      executedBy: "gap-ri-test",
      affectedObjects: [],
      firedAt: new Date().toISOString(),
    };

    // Two deliveries of the SAME effect with the SAME key over the REAL
    // production transport (deliverOneWebhook — the worker's dispatch path).
    const first = await deliverOneWebhook(spec, payload, { idempotencyKey: key });
    const second = await deliverOneWebhook(spec, payload, { idempotencyKey: key });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);

    const history = await controlledHistory();
    const calls = history.filter(
      (h) => h.endpoint === "/sideeffect/duplicate" && h.idempotencyKey === key,
    );
    expect(calls.length).toBe(2);
    expect(calls[0].duplicate).toBe(false); // first delivery: new effect
    expect(calls[1].duplicate).toBe(true); // retry collapsed by the receiver
  }, 20_000);

  it("3. timeout: unresponsive receiver is aborted by timeoutMs, retried with the same key, then dead-lettered", async () => {
    await controlledReset();
    const res = await apply(timeoutAction, `ri-obj-t-${Date.now()}`, `idem-rit-${Date.now()}`);
    expect(res.status).toBe(200);
    const execId = res.body.executionId as string;
    const expectedKey = `${execId}:wb:0`;

    await drainUntilDead(execId, 30_000);

    const row = await jobRow(execId);
    expect(row!.status).toBe("dead");
    expect(row!.attempt_count).toBeGreaterThanOrEqual(2);

    // The receiver recorded every attempt (status -1 = no response sent);
    // all attempts carried the SAME idempotency key — at-least-once
    // transport + stable key = exactly-once effect for dedup-aware receivers.
    const history = await controlledHistory();
    const attempts = history.filter(
      (h) => h.endpoint === "/writeback/timeout" && h.idempotencyKey?.startsWith(execId),
    );
    expect(attempts.length).toBeGreaterThanOrEqual(2);
    for (const a of attempts) {
      expect(a.responseStatus).toBe(-1);
      expect(a.idempotencyKey).toBe(expectedKey);
    }
  }, 45_000);
});
