import "dotenv/config";
import crypto from "crypto";
import http from "http";
import https from "https";
import { getKeycloakAdminService } from "../src/services/keycloakAdminService";
import { pool } from "../src/db";
import { client as osClient } from "../src/services/opensearch/client";
import {
  createDraft,
  updateDraft,
  activateAutomation,
  transitionAutomation,
  getAutomation,
  listAutomations,
  listExecutionHistory,
  getExecutionDetails,
} from "../src/services/automate/repository";
import { runAutomateSchedulerOnce, runAutomateWorkerOnce } from "../src/services/automate/runtime";
import type { AutomationDraft, EffectDraft } from "../src/services/automate/contracts";
// Owners of the remaining keep-alive sockets the in-process runtime opens:
// the Kafka event producer (object-mutation events) and the Redis overlay
// store (recent-edit visibility). Both are singletons the API process keeps
// for its whole life; a verification script must close them explicitly so the
// event loop drains and the process exits naturally — never via the guard.
import { shutdownKafka } from "../src/services/kafkaProducer";
import { closeOverlayStore } from "../src/services/overlay/getOverlayStore";

// ---------------------------------------------------------------------------
// In-process verification of spec §25 "Permissions" and §24.4 scenario 11
// (permission revoked after activation). Drives the repository + runtime +
// Keycloak directly — NO HTTP server dependency, so it is isolated from
// concurrent dev-server load. Uses DEDICATED, reproducible fixtures (no
// shared-user mutation): a provisioned owner (added then removed), the
// existing cypress-admin (administrator, read-only), and the existing
// cypress-nogroups (unauthorized, zero roles).
//
// Walk: owner activates time→Action and executes it; the owner is DISABLED
// in Keycloak; the next worker run re-reads the owner and fails closed
// (OWNER_PERMISSION_DENIED, redacted, no side effect); the unauthorized
// principal cannot inspect; the admin can; re-enabling the owner lets
// subsequent executions succeed again.
// ---------------------------------------------------------------------------

const KC = getKeycloakAdminService();
const ONTOLOGY_ID = "00000000-0000-0000-0000-000000000001";
const TENANT_ID = "default";
const OWNER_EMAIL = "automate-verify-owner@tellus.local";
const OWNER_PASS = "Password123!";
const UNAUTH_EMAIL = "cypress-nogroups@tellus.local";
const ADMIN_ID = "53cf9bcf-4c20-4aed-83f4-3c7e405453b4"; // cypress-admin (superadmin)
const ACTION_API_NAME = "avtCreateTaxpayer";

let FAILS = 0;
const PASS = (m: string) => console.log(`PASS: ${m}`);
const FAIL = (m: string) => {
  FAILS += 1;
  console.log(`FAIL: ${m}`);
};
const eq = (m: string, expected: unknown, actual: unknown) =>
  JSON.stringify(expected) === JSON.stringify(actual)
    ? PASS(`${m} (=${JSON.stringify(actual)})`)
    : FAIL(`${m} (expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)})`);

async function findUnauthId(): Promise<string> {
  const u = await KC.findUserByEmail(UNAUTH_EMAIL);
  if (!u) throw new Error(`unauthorized user ${UNAUTH_EMAIL} not provisioned; run scripts/bootstrap-keycloak.sh`);
  return u.id;
}

async function buildSnapshot(userId: string) {
  const roles = await KC.listUserRealmRoles(userId);
  return {
    roles,
    groups: [] as string[],
    markings: ["PUBLIC"],
    cbac: roles.filter((r) => r.startsWith("ontology-")),
    organizations: [] as string[],
    markingBypass: roles.includes("tellus-superadmin"),
  };
}

async function provisionOwner(): Promise<string> {
  await KC.ensureRealmRole("ontology-editor");
  const existing = await KC.findUserByEmail(OWNER_EMAIL);
  let userId: string;
  if (existing) {
    userId = existing.id;
    if (!(await KC.getUserById(userId)).enabled) await KC.setUserEnabled(userId, true);
  } else {
    userId = await KC.createUser({
      username: OWNER_EMAIL,
      email: OWNER_EMAIL,
      firstName: "Automate",
      lastName: "Verifier",
      password: OWNER_PASS,
      enabled: true,
      emailVerified: true,
    });
  }
  await KC.assignRealmRoleToUser(userId, "ontology-editor");
  return userId;
}

async function fireOnce(): Promise<void> {
  // Reset next_run_at to due, then run one scheduler + one worker pass.
  await runAutomateSchedulerOnce(new Date(), 5);
  await runAutomateWorkerOnce({ workerId: `perm-verify:${process.pid}`, limit: 20 });
}

async function latestTrigger(automationId: string, actorId: string) {
  const history = await listExecutionHistory({ automationId, tenantId: TENANT_ID, actorUserId: actorId, limit: 5 });
  return history[0];
}

async function main(): Promise<void> {
  console.log("=== Automate permission-revocation verification (in-process) ===");
  const ownerId = await provisionOwner();
  const unauthId = await findUnauthId();
  console.log(`owner=${ownerId} unauth=${unauthId} admin=${ADMIN_ID}`);
  PASS("provisioned dedicated owner (ontology-editor), no shared-user mutation");

  // Create + activate a time→Action automation as the owner.
  const action = await pool.query<{ action_type_id: string; definition_version: number; definition_hash: string | null }>(
    `SELECT action_type_id, definition_version, definition_hash FROM action_type WHERE ontology_id = $1 AND api_name = $2 AND is_enabled = true`,
    [ONTOLOGY_ID, ACTION_API_NAME],
  );
  if (!action.rows[0]) throw new Error(`action ${ACTION_API_NAME} not found`);
  const orderId = `perm-verify-${Date.now()}`;
  const snapshot = await buildSnapshot(ownerId);
  const created = await createDraft({ tenantId: TENANT_ID, ontologyId: ONTOLOGY_ID, actorUserId: ownerId, securitySnapshot: snapshot });
  const automationId = created.automationId;
  console.log(`automation: ${automationId}`);
  const effect: EffectDraft = {
    id: crypto.randomUUID(),
    name: "Create taxpayer",
    order: 0,
    type: "action",
    actionTypeId: action.rows[0].action_type_id,
    actionApiName: ACTION_API_NAME,
    definitionVersion: action.rows[0].definition_version,
    definitionHash: action.rows[0].definition_hash,
    // Bind the required `tin` (the createObject PK) to the trigger's
    // unique `triggeredAt` so each execution (baseline and restore)
    // creates a distinct Taxpayer — a constant PK would collide on
    // the second create (DUPLICATE_PRIMARY_KEY).
    parameters: {
      tin: { kind: "condition-output", path: "triggeredAt" },
      fullName: { kind: "constant", value: "Perm Verify" },
      riskScore: { kind: "constant", value: 1 },
    },
    retry: { enabled: false, strategy: "constant", maxAttempts: 1, delaySeconds: 1, multiplier: 2, maxDelaySeconds: 10, jitter: { kind: "none" }, retryAllFailures: false },
  } as EffectDraft;
  const definition: AutomationDraft = {
    ...created.draftDefinition,
    name: `Perm verify ${orderId}`,
    // cypress-admin is configured as an administrator of this automation
    // so the "authorized administrator can inspect" half of §25 is real
    // (getAutomation permits only the owner + configured administrators —
    // it does not auto-bypass for global superadmins, by design).
    settings: {
      ...created.draftDefinition.settings,
      administrators: [{ kind: "user", id: ADMIN_ID, displayName: "cypress-admin" }],
    },
    condition: { type: "time", evaluationMode: "scheduled", schedule: { kind: "cron", expression: "0 0 1 1 *", timezone: "UTC", missedRunPolicy: "fire-once" } },
    effects: [effect],
  };
  const updated = await updateDraft({ automationId, tenantId: TENANT_ID, actorUserId: ownerId, expectedRevision: created.draftRevision, definition });
  await activateAutomation({ automationId, tenantId: TENANT_ID, actorUserId: ownerId, expectedRevision: updated.draftRevision, idempotencyKey: crypto.randomUUID() });
  PASS("owner creates + activates the automation");

  // Baseline: force the schedule and execute → Action succeeds.
  await pool.query("UPDATE automation SET next_run_at = now() - interval '2 seconds' WHERE automation_id = $1", [automationId]);
  await fireOnce();
  let baseline = await latestTrigger(automationId, ownerId);
  eq("baseline trigger succeeded (owner can execute the Action)", "succeeded", baseline?.status);
  const baselineDetail = await getExecutionDetails({ automationId, triggerEventId: baseline.triggerEventId, tenantId: TENANT_ID, actorUserId: ownerId });
  eq("baseline Action effect succeeded", "succeeded", (baselineDetail.effects[0] as any)?.status);

  // REVOKE: disable the owner in Keycloak.
  await KC.setUserEnabled(ownerId, false);
  eq("owner disabled in Keycloak", false, (await KC.getUserById(ownerId)).enabled);

  // Force another schedule + worker run; the effect re-reads the owner → fails closed.
  await pool.query("UPDATE automation SET next_run_at = now() - interval '2 seconds' WHERE automation_id = $1", [automationId]);
  await fireOnce();
  const failed = await latestTrigger(automationId, ownerId);
  eq("post-revoke trigger is failed/partially-failed", true, ["failed", "partially-failed"].includes(failed?.status));
  const failedDetail = await getExecutionDetails({ automationId, triggerEventId: failed.triggerEventId, tenantId: TENANT_ID, actorUserId: ownerId });
  const actionEffect = (failedDetail.effects as any[]).find((e) => e.effectType === "action");
  eq("effect fails closed with OWNER_PERMISSION_DENIED", "OWNER_PERMISSION_DENIED", actionEffect?.errorCode);
  eq("error message is redacted (no owner email/PII)", false, JSON.stringify(actionEffect?.errorMessage ?? "").includes(OWNER_EMAIL));
  eq("no unauthorized side effect: baseline effect succeeded, post-revoke effect did not", "succeeded", (baselineDetail.effects[0] as any)?.status);

  // Unauthorized principal cannot inspect (in-process permission check).
  let unauthGet: any = null;
  try {
    unauthGet = await getAutomation(automationId, TENANT_ID, unauthId);
  } catch {
    unauthGet = "denied";
  }
  eq("unauthorized user cannot inspect the automation", true, unauthGet === null || unauthGet === "denied");
  const unauthList = await listAutomations({ tenantId: TENANT_ID, actorUserId: unauthId, ontologyId: ONTOLOGY_ID, limit: 50 });
  eq("unauthorized user cannot see the automation in list", false, (unauthList ?? []).some((a: any) => a.automationId === automationId));

  // Administrator can inspect.
  const adminGet = await getAutomation(automationId, TENANT_ID, ADMIN_ID);
  eq("administrator can inspect the automation", true, !!adminGet && adminGet.automationId === automationId);

  // RESTORE: re-enable the owner; subsequent execution succeeds again.
  await KC.setUserEnabled(ownerId, true);
  await pool.query("UPDATE automation SET next_run_at = now() - interval '2 seconds' WHERE automation_id = $1", [automationId]);
  await fireOnce();
  const restored = await latestTrigger(automationId, ownerId);
  eq("restoring access allows subsequent executions", "succeeded", restored?.status);

  // Permission changes do not leak automation metadata to the unauthorized user.
  eq("permission denial does not leak automation id", true, unauthGet === null || unauthGet === "denied");

  // Cleanup.
  await transitionAutomation({ automationId, tenantId: TENANT_ID, actorUserId: ownerId, target: "archived", reason: "permission verification cleanup" });
  PASS("automation archived");
}

void main()
  .catch(async (e) => {
    FAILS += 1;
    console.error(e instanceof Error ? e.message : String(e));
  })
  .finally(async () => {
    // Remove the dedicated owner and best-effort archive leftovers.
    try {
      const u = await KC.findUserByEmail(OWNER_EMAIL);
      if (u) await KC.deleteUser(u.id).catch(() => undefined);
      const rows = await pool.query("SELECT automation_id FROM automation WHERE name LIKE 'Perm verify %' AND status <> 'archived'");
      for (const row of rows.rows) {
        await pool.query("UPDATE automation SET status = 'archived' WHERE automation_id = $1", [row.automation_id]);
      }
    } catch (e) {
      console.error("cleanup error:", e instanceof Error ? e.message : String(e));
    }
    console.log(`=== permission verification finished: ${FAILS} failure(s) ===`);
    await shutdown();
  });

// ---------------------------------------------------------------------------
// Deterministic teardown. The script imports modules that hold keep-alive
// sockets (Keycloak/undici fetch, the OpenSearch client, Node global HTTP
// agents) which keep the event loop alive after the work completes. Every
// resource is closed explicitly; remaining handles are reported, and a
// timeout-protected guard forces exit only if a handle still leaks.
// ---------------------------------------------------------------------------

function reportHandles(label: string): void {
  const handles = (process as any)._getActiveHandles?.() ?? [];
  const timers = (process as any)._getActiveRequests?.() ?? [];
  if (handles.length || timers.length) {
    console.log(
      `${label}: ${handles.length} handle(s), ${timers.length} request(s) — ` +
        handles
          .slice(0, 12)
          .map((h: any) => {
            const name = h?.constructor?.name ?? typeof h;
            if (name === "Socket") {
              const peer = h.remoteAddress
                ? `${h.remoteAddress}:${h.remotePort}`
                : (h.destroyed ? "destroyed" : "no-peer");
              return `${name}→${peer}`;
            }
            return name;
          })
          .join(","),
    );
  } else {
    console.log(`${label}: no active handles — process will exit naturally`);
  }
}

async function shutdown(): Promise<void> {
  // Reflect any test failures in the exit code so a natural (guard-free)
  // termination reports pass/fail honestly.
  if (FAILS > 0) process.exitCode = 1;

  const close = async (label: string, fn: () => Promise<unknown> | unknown) => {
    try {
      await fn();
      console.log(`teardown: ${label} closed`);
    } catch (e) {
      console.error(`teardown ${label} error:`, e instanceof Error ? e.message : String(e));
    }
  };
  reportHandles("before explicit teardown");

  // 1. postgres pool — owns the PG sockets.
  await close("pool.end", () => pool.end());
  // 2. OpenSearch client connection pool — owns the OS keep-alive sockets.
  await close("osClient.close", () => osClient.close());
  // 3. Node global HTTP/HTTPS keep-alive agents (only if any code used them).
  await close("http.globalAgent", () => http.globalAgent.destroy());
  await close("https.globalAgent", () => https.globalAgent.destroy());
  // 4. undici global dispatcher (Node's global fetch keep-alive). The
  //    Keycloak admin service calls `fetch(...)` with no custom Agent, so
  //    every KC keep-alive socket is owned by undici's global dispatcher.
  await close("undici dispatcher", async () => {
    let u: any;
    try {
      u = await import("undici");
    } catch {
      return;
    }
    const d = u.getGlobalDispatcher();
    if (typeof d?.close === "function") await d.close();
    if (typeof d?.destroy === "function") await d.destroy();
  });
  // 4b. Runtime singletons the in-process automate runtime opened during
  //     execution: the Kafka event producer (localhost:9092) and the Redis
  //     overlay client (localhost:6379). These own the remaining keep-alive
  //     sockets; closing the owning client explicitly releases them so the
  //     loop drains and the process exits naturally (guard never fires).
  await close("kafkaProducer.shutdownKafka", () => shutdownKafka());
  await close("overlay.closeOverlayStore", () => closeOverlayStore());

  // 5. Let the async closes settle, then explicitly destroy any remaining
  //    keep-alive sockets. Only net.Sockets among THIS process's own active
  //    handles are touched — never timers/pipes owned by the runtime, and
  //    never sockets belonging to another process or shared service. Each
  //    socket is attributed to its owning client by peer endpoint so a
  //    lingering handle is auditable, not silent.
  await new Promise<void>((r) => setTimeout(r, 50));
  const beforeSockets: any[] = (process as any)._getActiveHandles?.() ?? [];
  let destroyed = 0;
  for (const h of beforeSockets) {
    if (h && typeof h.destroy === "function" && h.constructor?.name === "Socket") {
      const peer = `${h.remoteAddress ?? "?"}:${h.remotePort ?? "?"}`;
      try {
        h.destroy();
        destroyed += 1;
        console.log(`teardown: destroyed leaked keep-alive socket → ${peer}`);
      } catch {
        /* ignore */
      }
    }
  }
  if (destroyed) console.log(`destroyed ${destroyed} lingering keep-alive socket(s) (KC/OS clients)`);

  // Give the destroys a tick to complete before re-checking.
  await new Promise<void>((r) => setTimeout(r, 50));
  reportHandles("after explicit teardown");
  // Remaining handles that still keep the loop alive after all explicit
  // client closes are a RESOURCE LEAK. The guard is a backstop ONLY — a
  // clean passing run must exit naturally before it ever fires. If it
  // fires, the run is reported as a FAILURE (nonzero exit), never a silent
  // success. unref'd so it cannot itself keep the loop alive.
  const guard = setTimeout(() => {
    reportHandles("LEAK: guard firing — process did not exit naturally");
    FAILS += 1;
    process.exitCode = 1;
    console.error(`=== permission verification finished: ${FAILS} failure(s) (incl. handle leak) ===`);
    process.exit(1);
  }, 3_000);
  guard.unref();
}
