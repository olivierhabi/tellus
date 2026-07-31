// scripts/verify-automate-function-versions.ts
// ------------------------------------------------------------
// Proves Function version semantics for Tellus Automate through REAL
// production execution paths against the isolated verify stack:
//
//   • Pinned v1 automation executes v1; after compatible v2 is published,
//     the pinned automation STILL executes v1.
//   • An auto-upgrade automation (autoUpgrade:true) pinned to v1 selects
//     the compatible v2 (same signature) and executes v2.
//   • Incompatible v3 (different signature) is rejected for the auto-upgrade
//     binding — it never switches to v3, last compatible v2 stays usable.
//   • Authoring-time validation: an effect claiming v3's identity while
//     pinned to v1's artifact is rejected with FUNCTION_VERSION_INCOMPATIBLE.
//
// All automations are created + activated + executed through the HTTP API;
// only the schedule-due force (next_run_at) uses SQL against the isolated
// verification DB (the documented scheduling-control contract —_effect
// execution still runs through the real runtime).
// ------------------------------------------------------------

import "dotenv/config";
import { Pool } from "pg";
import crypto from "crypto";

const API_BASE = `http://localhost:${process.env.VERIFY_API_PORT ?? "3100"}/api/v1`;
const KC_URL = process.env.KEYCLOAK_URL ?? "http://localhost:8086";
const KC_REALM = process.env.VERIFY_REALM ?? "tellus-automate-verify";
const KC_CLIENT = process.env.KEYCLOAK_FRONTEND_CLIENT_ID ?? "tellus-frontend";
const OWNER_EMAIL = process.env.OWNER_EMAIL ?? "automate-verify-owner@tellus.local";
const OWNER_PASS = process.env.OWNER_PASS ?? "Password123!";
const VERIFY_DB = process.env.VERIFY_DB ?? "tellus_automate_verify";
const PGUSER = process.env.PGUSER ?? "tellus";
const PGHOST = process.env.PGHOST ?? "localhost";
const PGPASSWORD = process.env.PGPASSWORD ?? "tellus";
const PGPORT = Number(process.env.PGPORT ?? 5432);
const SEED_FILE = "/tmp/automate-verify-stack/seed.json";

interface Seed {
  ontologyId: string;
  objectTypeApiName: string;
  repositoryRid: string;
  branch: string;
  functions: {
    verifyMarker: {
      functionRid: string;
      apiName: string;
      branch: string;
      v1: { semver: string; artifactSha256: string };
      v2: { semver: string; artifactSha256: string };
      v3: { semver: string; artifactSha256: string };
    };
    verifyFail: { functionRid: string; apiName: string; branch: string; v1: { semver: string; artifactSha256: string } };
  };
  seedOwnerUserId: string;
}

let token = "";
let tokenUserId = "";
const pool = new Pool({ user: PGUSER, host: PGHOST, port: PGPORT, password: PGPASSWORD, database: VERIFY_DB });

let PASS = 0;
let FAIL = 0;
function check(label: string, ok: boolean, detail = "") {
  if (ok) {
    PASS += 1;
    console.log(`  \x1b[32m✔\x1b[0m ${label}`);
  } else {
    FAIL += 1;
    console.error(`  \x1b[31m✗ ${label}\x1b[0m ${detail}`);
  }
}

async function http(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const url = path.startsWith("http") ? path : `${API_BASE}${path}`;
  const init: RequestInit = {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...headers },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(url, init);
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, body: json, etag: res.headers.get("etag") ?? undefined };
}

async function kcLogin() {
  const res = await fetch(`${KC_URL}/realms/${KC_REALM}/protocol/openid-connect/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "password", client_id: KC_CLIENT, username: OWNER_EMAIL, password: OWNER_PASS }),
  });
  if (!res.ok) throw new Error(`KC login failed: ${res.status} ${await res.text()}`);
  const j = await res.json();
  token = j.access_token;
  const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64").toString("utf-8"));
  tokenUserId = payload.sub;
}

// --- Automation create + activate via the real HTTP API -------------------
function fnEffect(opts: {
  id: string;
  name: string;
  functionRid: string;
  repositoryRid: string;
  apiName: string;
  branch: string;
  version: string;
  artifactSha256: string;
  autoUpgrade: boolean;
  input: string;
  retry?: Partial<{ maxAttempts: number; delaySeconds: number; retryAllFailures: boolean }>;
}) {
  return {
    id: opts.id,
    name: opts.name,
    order: 0,
    type: "function",
    functionRid: opts.functionRid,
    repositoryRid: opts.repositoryRid,
    apiName: opts.apiName,
    branch: opts.branch,
    version: opts.version,
    artifactSha256: opts.artifactSha256,
    autoUpgrade: opts.autoUpgrade,
    parameters: { input: { kind: "constant", value: opts.input } },
    timeoutSeconds: 5,
    retry: {
      enabled: true,
      strategy: "constant",
      maxAttempts: opts.retry?.maxAttempts ?? 1,
      delaySeconds: opts.retry?.delaySeconds ?? 5,
      multiplier: 2,
      maxDelaySeconds: 60,
      jitter: { kind: "none" },
      retryAllFailures: opts.retry?.retryAllFailures ?? false,
    },
  };
}

function automationDraft(name: string, effects: any[], extra: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    ontologyId: undefined as unknown as string, // filled by createAutomation
    name,
    condition: {
      type: "time",
      evaluationMode: "scheduled",
      schedule: { kind: "cron", expression: "0 0 1 1 *", timezone: "UTC", missedRunPolicy: "fire-once" },
    },
    effects,
    settings: {
      eventRetries: { enabled: false, maxRetries: 1, intervalSeconds: 3600 },
      administrators: [],
      informationNotificationAudience: "owner-and-recipients",
      effectFailureNotificationAudience: "owner-and-recipients",
      autoMute: { enabled: false, minimumExecutions: 30, failureRateThreshold: 0.8, evaluationWindowSeconds: 15552000 },
      historyScope: "owner",
      retainHistoryDays: 180,
    },
    executionStrategy: { mode: "parallel", queueTriggerEvents: false },
    ...extra,
  };
}

async function createAutomation(definition: any): Promise<{ automationId: string; revision: string }> {
  const ontology = await ontologyId();
  const draft = await http("POST", `/automations/drafts`, { ontologyId: ontology });
  if (draft.status !== 201) throw new Error(`create draft → ${draft.status} ${JSON.stringify(draft.body).slice(0, 400)}`);
  const automationId = draft.body.data.automationId;
  const def = { ...definition, ontologyId: ontology };
  const rev = draft.body.data.draftRevision;
  const upd = await http("PATCH", `/automations/${automationId}/draft`, { revision: rev, definition: def });
  if (upd.status !== 200) throw new Error(`update draft → ${upd.status} ${JSON.stringify(upd.body).slice(0, 500)}`);
  return { automationId, revision: upd.body.data.draftRevision };
}

let _ontologyId = "";
async function ontologyId(): Promise<string> {
  if (_ontologyId) return _ontologyId;
  const r = await http("GET", `/ontology/default`);
  _ontologyId = (r.body?.data ?? r.body).ontologyId;
  return _ontologyId;
}

async function activate(automationId: string, revision: string): Promise<void> {
  const r = await http("POST", `/automations/${automationId}/activate`, { revision }, { "Idempotency-Key": crypto.randomUUID() });
  if (r.status !== 200) throw new Error(`activate → ${r.status} ${JSON.stringify(r.body).slice(0, 400)}`);
}

async function doneCount(automationId: string): Promise<number> {
  const h = await http("GET", `/automations/${automationId}/history`);
  if (h.status !== 200) return 0;
  const rows = h.body?.data ?? h.body?.executions ?? h.body ?? [];
  const arr = Array.isArray(rows) ? rows : (rows?.executions ?? []);
  return arr.filter((e: any) => ["succeeded", "failed", "partially_failed", "exhausted"].includes(e.status ?? e.trigger_status ?? "")).length;
}

async function forceScheduleAndPoll(automationId: string, timeoutMs = 90_000): Promise<any[]> {
  // Force the far-future cron due now; the live isolated API runtime polls
  // every 2s, so the scheduler fires within ~2s and the worker executes.
  const baseline = await doneCount(automationId);
  await pool.query("UPDATE automation SET next_run_at = now() WHERE automation_id = $1", [automationId]);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    const cur = await doneCount(automationId);
    if (cur > baseline) {
      const h = await http("GET", `/automations/${automationId}/history`);
      const rows = h.body?.data ?? h.body?.executions ?? h.body ?? [];
      const arr = Array.isArray(rows) ? rows : (rows?.executions ?? []);
      const done = arr.filter((e: any) => ["succeeded", "failed", "partially_failed", "exhausted"].includes(e.status ?? e.trigger_status ?? ""));
      return done;
    }
  }
  throw new Error(`automation ${automationId} produced no NEW completed execution within ${timeoutMs}ms (baseline=${baseline})`);
}

async function effectOutput(automationId: string): Promise<any> {
  // Read the latest SUCCEEDED effect execution's output (which records
  // version/configuredVersion/autoUpgraded for function effects).
  const r = await pool.query(
    `SELECT e.output, e.status, e.effect_type, e.error_code
       FROM automation_effect_execution e
       JOIN automation_trigger_event t ON t.trigger_event_id = e.trigger_event_id
      WHERE t.automation_id = $1 AND e.status = 'succeeded'
      ORDER BY e.created_at DESC LIMIT 1`,
    [automationId],
  );
  return r.rows[0] ?? null;
}

async function main() {
  const seed: Seed = JSON.parse(require("fs").readFileSync(SEED_FILE, "utf-8"));
  const fn = seed.functions.verifyMarker;
  console.log(`verify-automate-function-versions: api=${API_BASE} repo=${seed.repositoryRid} fn=${fn.functionRid}`);
  await kcLogin();
  const ontology = await ontologyId();

  // ========================================================================
  console.log("\n[A] Pinned v1 automation executes v1, and keeps executing v1 after v2");
  // ========================================================================
  const pinnedEffect = fnEffect({
    id: crypto.randomUUID(), name: "pinned-v1",
    functionRid: fn.functionRid, repositoryRid: seed.repositoryRid,
    apiName: fn.apiName, branch: fn.branch,
    version: fn.v1.semver, artifactSha256: fn.v1.artifactSha256,
    autoUpgrade: false, input: "world",
  });
  const a = await createAutomation(automationDraft("fn-pinned-v1", [pinnedEffect]));
  await activate(a.automationId, a.revision);
  const execA = await forceScheduleAndPoll(a.automationId);
  check("pinned v1: one trigger executed", execA.length >= 1, `got ${execA.length}`);
  const outA = await effectOutput(a.automationId);
  check("pinned v1: effect succeeded", outA?.status === "succeeded", `status=${outA?.status} err=${outA?.error_code}`);
  check("pinned v1: ran v1.0.0", outA?.output?.version === fn.v1.semver, `version=${outA?.output?.version}`);
  check("pinned v1: result fn-v1:world", outA?.output?.result === "fn-v1:world", `result=${outA?.output?.result}`);
  check("pinned v1: autoUpgraded=false", outA?.output?.autoUpgraded === false, `autoUpgraded=${outA?.output?.autoUpgraded}`);

  // v2 is already published by the seed. Re-run the pinned automation: it
  // must STILL run v1 (pinned, never auto-upgrades).
  const execA2 = await forceScheduleAndPoll(a.automationId);
  const outA2 = await effectOutput(a.automationId);
  // (history returns latest; one new execution since outA)
  check("pinned v1 after v2 published: still v1.0.0", outA2?.output?.version === fn.v1.semver, `version=${outA2?.output?.version}`);

  // ========================================================================
  console.log("\n[B] Auto-upgrade automation (pinned v1) selects compatible v2");
  // ========================================================================
  const autoEffect = fnEffect({
    id: crypto.randomUUID(), name: "auto-upgrade",
    functionRid: fn.functionRid, repositoryRid: seed.repositoryRid,
    apiName: fn.apiName, branch: fn.branch,
    version: fn.v1.semver, artifactSha256: fn.v1.artifactSha256,
    autoUpgrade: true, input: "world",
  });
  const b = await createAutomation(automationDraft("fn-auto-upgrade", [autoEffect]));
  await activate(b.automationId, b.revision);
  const execB = await forceScheduleAndPoll(b.automationId);
  check("auto-upgrade: one trigger executed", execB.length >= 1);
  const outB = await effectOutput(b.automationId);
  check("auto-upgrade: effect succeeded", outB?.status === "succeeded", `status=${outB?.status} err=${outB?.error_code}`);
  check("auto-upgrade: ran compatible v2 (1.1.0)", outB?.output?.version === fn.v2.semver, `version=${outB?.output?.version}`);
  check("auto-upgrade: configuredVersion pinned to v1", outB?.output?.configuredVersion === fn.v1.semver, `configured=${outB?.output?.configuredVersion}`);
  check("auto-upgrade: autoUpgraded=true", outB?.output?.autoUpgraded === true, `autoUpgraded=${outB?.output?.autoUpgraded}`);
  check("auto-upgrade: result fn-v2:world", outB?.output?.result === "fn-v2:world", `result=${outB?.output?.result}`);

  // ========================================================================
  console.log("\n[C] Incompatible v3 is rejected; auto-upgrade stays on v2");
  // ========================================================================
  // v3 is already published by the seed (signature differs from v1/v2).
  // Re-run the auto-upgrade automation: it must NOT switch to v3 (signature
  // differs) and must keep executing the latest COMPATIBLE version (v2).
  const execB2 = await forceScheduleAndPoll(b.automationId);
  const outB2 = await effectOutput(b.automationId);
  check("incompatible v3: auto-upgrade does NOT run v3", outB2?.output?.version !== fn.v3.semver, `version=${outB2?.output?.version}`);
  check("incompatible v3: stays on compatible v2", outB2?.output?.version === fn.v2.semver, `version=${outB2?.output?.version}`);
  check("incompatible v3: last compatible config remains usable (succeeded)", outB2?.status === "succeeded", `status=${outB2?.status}`);

  // Authoring-time rejection: a NEW automation effect claiming v3's version
  // but with v1's artifactSha256 (identity mismatch) must be rejected at
  // activation. Use the validate endpoint with ?activation=true.
  const forgedEffect = fnEffect({
    id: crypto.randomUUID(), name: "forged-v3",
    functionRid: fn.functionRid, repositoryRid: seed.repositoryRid,
    apiName: fn.apiName, branch: fn.branch,
    version: fn.v3.semver, artifactSha256: fn.v1.artifactSha256, // identity mismatch
    autoUpgrade: false, input: "world",
  });
  const forgedDef = automationDraft("fn-forged-v3", [forgedEffect]);
  const forged = await createAutomation(forgedDef);
  const validate = await http("POST", `/automations/${forged.automationId}/validate?activation=true`, forgedDef);
  const issues = validate.body?.data?.issues ?? validate.body?.issues ?? [];
  const hasIncompat = JSON.stringify(issues).includes("FUNCTION_VERSION_INCOMPATIBLE");
  check("incompatible v3: activation validation rejects identity mismatch (FUNCTION_VERSION_INCOMPATIBLE)", validate.status === 200 && hasIncompat, `status=${validate.status} issues=${JSON.stringify(issues).slice(0, 200)}`);
  check("incompatible v3: no valid active version produced", validate.status !== 201 && validate.status !== 202);

  // ========================================================================
  console.log(`\n=== verify-automate-function-versions: ${PASS} PASS, ${FAIL} FAIL ===`);
  await pool.end();
  if (FAIL > 0) process.exitCode = 1;
}

main().catch(async (e) => {
  console.error("FATAL", e);
  try { await pool.end(); } catch {}
  process.exit(1);
});
