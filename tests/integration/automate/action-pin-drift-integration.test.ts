import crypto from "crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { pool } from "../../../src/db";
import {
  activateAutomation,
  createDraft,
  updateDraft,
  appendAutomationAudit,
  AutomationServiceError,
} from "../../../src/services/automate/repository";
import { repinAutomationsForActionType } from "../../../src/services/automate/repin";
import {
  createActionType,
  updateActionType,
} from "../../../src/models/actionType";
import type { AutomationDraft } from "../../../src/services/automate/contracts";

// Incident reproduction: pre-fix, ANY action-type definition bump broke
// activation of every pinning automation (AUTOMATION_DEFINITION_CHANGED).
// Post-fix: cosmetic/compatible drift auto re-pins; breaking drift fails
// with ACTION_DEFINITION_CHANGED_BREAKING + a diff summary.

const tenantId = "pin-drift-integration";
const actorUserId = crypto.randomUUID();
let ontologyId = "";
let actionTypeId = "";
const apiName = `iTestAction${crypto.randomUUID().slice(0, 4)}`;

function actionEffectPin(opts: {
  version: number;
  hash: string | null;
  apiName: string;
  actionTypeId: string;
}) {
  return {
    id: crypto.randomUUID(),
    name: "Create thing",
    type: "action" as const,
    order: 0,
    retry: {
      enabled: false,
      strategy: "constant" as const,
      maxAttempts: 1,
      delaySeconds: 1,
      multiplier: 2,
      maxDelaySeconds: 1,
      jitter: { kind: "none" as const },
      retryAllFailures: false,
    },
    actionTypeId: opts.actionTypeId,
    actionApiName: opts.apiName,
    definitionVersion: opts.version,
    definitionHash: opts.hash,
    parameters: {
      orderid: { kind: "constant" as const, value: "TEST-1" },
      a: { kind: "constant" as const, value: "v" },
    },
  };
}

async function makeAutomationWithPin(effect: unknown) {
  const created = await createDraft({
    tenantId,
    ontologyId,
    actorUserId,
    actorDisplayName: "ITest",
    securitySnapshot: { roles: ["ontology-admin"] },
  });
  const transformed = await updateDraft({
    automationId: created.automationId,
    tenantId,
    actorUserId,
    expectedRevision: created.draftRevision,
    definition: {
      ...created.draftDefinition,
      effects: [effect],
    } satisfies Partial<AutomationDraft> as unknown,
  });
  return transformed;
}

async function activateNow(automationId: string, revision: number) {
  return activateAutomation({
    automationId,
    tenantId,
    actorUserId,
    expectedRevision: revision,
    idempotencyKey: crypto.randomUUID(),
  });
}

async function activateExpectFailure(automationId: string, revision: number) {
  return activateNow(automationId, revision).then(
    () => ({ ok: true as const }),
    (e: unknown) => ({ ok: false as const, error: e as AutomationServiceError }),
  );
}

async function auditTypes(automationId: string): Promise<string[]> {
  const rows = await pool.query<{ event_type: string }>(
    `SELECT event_type FROM automation_audit_event WHERE automation_id = $1 ORDER BY created_at`,
    [automationId],
  );
  return rows.rows.map((r) => r.event_type);
}

beforeAll(async () => {
  const ontology = await pool.query<{ ontology_id: string }>(
    "SELECT ontology_id FROM ontology ORDER BY created_at LIMIT 1",
  );
  if (!ontology.rows[0]) throw new Error("integration tests need an ontology");
  ontologyId = ontology.rows[0].ontology_id;
  const created = await createActionType(ontologyId, {
    apiName,
    displayName: "ITest action",
    parameters: [
      { apiName: "orderid", type: "string", required: true },
    ] as never,
    rules: [
      {
        ruleId: "r1",
        type: "createObject",
        objectType: "AckManualSrc",
        properties: { orderId: { param: "orderid", source: "parameter" } },
      },
    ] as never,
    semanticsVersion: 1,
  } as never);
  actionTypeId = created.action_type_id;
});

afterAll(async () => {
  // The shared background automate runtime may have executed these tenant
  // automations; delete the full FK tree in dependency order before the
  // automation + action-type rows themselves.
  const ids = pool.query(
    `SELECT automation_id FROM automation WHERE tenant_id = $1`,
    [tenantId],
  );
  const automationIds = (await ids).rows.map((r) => r.automation_id as string);
  if (automationIds.length > 0) {
    await pool.query(
      `DELETE FROM automation_effect_attempt
        WHERE effect_execution_id IN (
          SELECT effect_execution_id FROM automation_effect_execution
           WHERE trigger_event_id IN (SELECT trigger_event_id FROM automation_trigger_event WHERE automation_id = ANY($1::uuid[]))
        )`,
      [automationIds],
    );
    await pool.query(
      `DELETE FROM automation_effect_execution
        WHERE trigger_event_id IN (SELECT trigger_event_id FROM automation_trigger_event WHERE automation_id = ANY($1::uuid[]))`,
      [automationIds],
    );
    await pool.query(
      `DELETE FROM automation_trigger_event WHERE automation_id = ANY($1::uuid[])`,
      [automationIds],
    );
    await pool.query(
      `DELETE FROM automation_condition_evaluation WHERE automation_id = ANY($1::uuid[])`,
      [automationIds],
    ).catch(() => undefined);
    await pool.query(
      `DELETE FROM automation_audit_event WHERE automation_id = ANY($1::uuid[])`,
      [automationIds],
    );
    await pool.query(
      `DELETE FROM automation_dependency WHERE child_automation_id = ANY($1::uuid[]) OR parent_automation_id = ANY($1::uuid[])`,
      [automationIds],
    ).catch(() => undefined);
    await pool.query(
      `DELETE FROM automation_condition_state WHERE automation_id = ANY($1::uuid[])`,
      [automationIds],
    ).catch(() => undefined);
  }
  await pool.query(`DELETE FROM automation WHERE tenant_id = $1`, [tenantId]);
  await pool.query(`DELETE FROM action_type WHERE ontology_id = $1 AND api_name LIKE $2`, [ontologyId, `${apiName}%`]);
});

describe("incident repro: cosmetic version bump no longer blocks activation", () => {
  it("persistence: action-type creation writes definition_hash + history", async () => {
    const row = await pool.query<{
      definition_hash: string | null;
      definition_version: number | null;
    }>(`SELECT definition_hash, definition_version FROM action_type WHERE action_type_id = $1`, [actionTypeId]);
    expect(row.rows[0]?.definition_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.rows[0]?.definition_version).toBe(1);
    const history = await pool.query(
      `SELECT 1 FROM action_type_definition_history WHERE action_type_id = $1`,
      [actionTypeId],
    );
    expect(history.rowCount).toBe(1);
  });

  it("cosmetic bump (reordered parameters) → activation re-pins + audit", async () => {
    const seed = await pool.query<{ definition_hash: string }>(
      `SELECT definition_hash FROM action_type WHERE action_type_id = $1`, [actionTypeId]);
    // Pin at v1
    const automation = await makeAutomationWithPin(
      actionEffectPin({ version: 1, hash: seed.rows[0].definition_hash, apiName, actionTypeId }),
    );
    // Cosmetic-semantic edit: same parameters, different JSONB order
    // → trigger bumps version; canonical hash stays identical.
    await updateActionType(ontologyId, apiName, {
      parameters: [
        { apiName: "note", type: "string", required: false },
        { apiName: "orderid", type: "string", required: true },
      ],
    } as never);
    const after = await pool.query<{ definition_version: number; definition_hash: string }>(
      `SELECT definition_version, definition_hash FROM action_type WHERE action_type_id = $1`, [actionTypeId]);
    expect(after.rows[0].definition_version).toBe(2);
    // NOTE: this ADDS an optional param (compatible), it is NOT purely cosmetic —
    // it exercises the compatible path; correctness asserted below via codes.

    const activated = await activateNow(automation.automationId, automation.draftRevision);
    expect(activated.currentVersion).toBe(1);
    const events = await auditTypes(automation.automationId);
    expect(events).toContain("AUTOMATION_EFFECT_PIN_UPGRADED");
    // Activated version pin moved forward deterministically to v2
    const versionRow = await pool.query<{ definition: { effects: Array<{ definitionVersion?: number; definitionHash?: string | null }> } }>(
      `SELECT definition FROM automation_version WHERE automation_id = $1 AND version = 1`,
      [automation.automationId],
    );
    expect(versionRow.rows[0].definition.effects[0].definitionVersion).toBe(2);
  });

  it("purely cosmetic bump (reordered identical params) → refreshed (no warning)", async () => {
    const apiName2 = `${apiName}Cosm`;
    const created = await createActionType(ontologyId, {
      apiName: apiName2,
      displayName: "ITest action 2",
      parameters: [
        { apiName: "a", type: "string", required: true },
        { apiName: "b", type: "string", required: false },
      ] as never,
      rules: [] as never,
      semanticsVersion: 1,
    } as never);
    const seed = await pool.query<{ definition_hash: string }>(
      `SELECT definition_hash FROM action_type WHERE action_type_id = $1`, [created.action_type_id]);
    const automation = await makeAutomationWithPin(
      actionEffectPin({ version: 1, hash: seed.rows[0].definition_hash, apiName: apiName2, actionTypeId: created.action_type_id }),
    );
    // Reorder parameters array ONLY → version bumps, canonical hash identical.
    await updateActionType(ontologyId, apiName2, {
      parameters: [
        { apiName: "b", type: "string", required: false },
        { apiName: "a", type: "string", required: true },
      ],
    } as never);
    await activateNow(automation.automationId, automation.draftRevision);
    const events = await auditTypes(automation.automationId);
    expect(events).toContain("AUTOMATION_EFFECT_PIN_REFRESHED");
    expect(events).not.toContain("AUTOMATION_EFFECT_PIN_UPGRADED");
    await pool.query(`DELETE FROM action_type WHERE action_type_id = $1`, [created.action_type_id]);
  });

  it("breaking bump (parameter removed) → 422 BREAKING + summary + remediation", async () => {
    const apiName3 = `${apiName}Break`;
    const created = await createActionType(ontologyId, {
      apiName: apiName3,
      displayName: "ITest action 3",
      parameters: [{ apiName: "orderid", type: "string", required: true }] as never,
      rules: [] as never,
      semanticsVersion: 1,
    } as never);
    const seed = await pool.query<{ definition_hash: string }>(
      `SELECT definition_hash FROM action_type WHERE action_type_id = $1`, [created.action_type_id]);
    const automation = await makeAutomationWithPin(
      actionEffectPin({ version: 1, hash: seed.rows[0].definition_hash, apiName: apiName3, actionTypeId: created.action_type_id }),
    );
    // Introduce an incompatible change: PARAMETERS to [] with required param gone
    await updateActionType(ontologyId, apiName3, { parameters: [] as never });
    const result = await activateExpectFailure(automation.automationId, automation.draftRevision);
    if (result.ok) throw new Error("activation should have failed");
    expect(result.error).toBeInstanceOf(AutomationServiceError);
    expect(result.error.code).toBe("AUTOMATION_DEFINITION_INVALID");
    const issues = (result.error.details?.issues ?? []) as Array<{ code: string; severity: string; message: string; details?: { changes?: Array<{ message: string }> } }>;
    const breaking = issues.find((i) => i.code === "ACTION_DEFINITION_CHANGED_BREAKING");
    expect(breaking).toBeDefined();
    expect(breaking!.message).toContain("parameter `orderid` removed");
    expect(breaking!.message).toContain("re-select the Action Type");
    await pool.query(`DELETE FROM action_type WHERE action_type_id = $1`, [created.action_type_id]);
  });

  it("unknown pin (no history snapshot) → legacy deprecated code", async () => {
    const apiName4 = `${apiName}Legacy`;
    const created = await createActionType(ontologyId, {
      apiName: apiName4,
      displayName: "ITest action 4",
      parameters: [{ apiName: "orderid", type: "string", required: true }] as never,
      rules: [] as never,
      semanticsVersion: 1,
    } as never);
    // Pin at version 5 that NEVER existed — no snapshot → legacy error
    const automation = await makeAutomationWithPin(
      actionEffectPin({ version: 5, hash: null, apiName: apiName4, actionTypeId: created.action_type_id }),
    );
    const result = await activateExpectFailure(automation.automationId, automation.draftRevision);
    if (result.ok) throw new Error("activation should have failed");
    const issues = (result.error.details?.issues ?? []) as Array<{ code: string }>;
    expect(issues.map((i) => i.code)).toContain("ACTION_DEFINITION_CHANGED");
    await pool.query(`DELETE FROM action_type WHERE action_type_id = $1`, [created.action_type_id]);
  });
});

describe("bulk repin endpoint contract", () => {
  it("dryRun classifies without writes; apply migrates only compatible pins (idempotent)", async () => {
    const apiName5 = `${apiName}Bulk`;
    const created = await createActionType(ontologyId, {
      apiName: apiName5,
      displayName: "ITest action 5",
      parameters: [{ apiName: "orderid", type: "string", required: true }] as never,
      rules: [] as never,
      semanticsVersion: 1,
    } as never);
    const seed = await pool.query<{ definition_hash: string }>(
      `SELECT definition_hash FROM action_type WHERE action_type_id = $1`, [created.action_type_id]);
    const compatibleAuto = await makeAutomationWithPin(
      actionEffectPin({ version: 1, hash: seed.rows[0].definition_hash, apiName: apiName5, actionTypeId: created.action_type_id }),
    );
    const unknownAuto = await makeAutomationWithPin(
      actionEffectPin({ version: 42, hash: null, apiName: apiName5, actionTypeId: created.action_type_id }),
    );
    await updateActionType(ontologyId, apiName5, {
      parameters: [
        { apiName: "orderid", type: "string", required: true },
        { apiName: "note", type: "string", required: false },
      ],
    } as never);

    const dry = await repinAutomationsForActionType({
      actionTypeId: created.action_type_id, tenantId, actorUserId,
      strategy: "latest-compatible", dryRun: true,
    });
    const compat = dry.results.find((r) => r.automationId === compatibleAuto.automationId);
    const unknown = dry.results.find((r) => r.automationId === unknownAuto.automationId);
    expect(compat?.status).toBe("migrated");
    expect(unknown?.status).toBe("needsManualReview");
    // dry-run must be side-effect free: draft revisions unchanged
    const revBefore = await pool.query<{ draft_revision: number }>(
      `SELECT draft_revision FROM automation WHERE automation_id = $1`, [compatibleAuto.automationId]);
    expect(Number(revBefore.rows[0].draft_revision)).toBe(compatibleAuto.draftRevision);

    const applied = await repinAutomationsForActionType({
      actionTypeId: created.action_type_id, tenantId, actorUserId,
      strategy: "latest-compatible", dryRun: false, requestId: crypto.randomUUID(),
    });
    expect(applied.results.find((r) => r.automationId === compatibleAuto.automationId)?.status).toBe("migrated");
    expect(applied.results.find((r) => r.automationId === unknownAuto.automationId)?.status).toBe("needsManualReview");
    const revAfter = await pool.query<{ draft_revision: number; definition: { effects: Array<{ definitionVersion?: number }> } }>(
      `SELECT draft_revision, draft_definition AS definition FROM automation WHERE automation_id = $1`, [compatibleAuto.automationId]);
    expect(Number(revAfter.rows[0].draft_revision)).toBe(compatibleAuto.draftRevision + 1);
    expect(revAfter.rows[0].definition.effects[0].definitionVersion).toBe(2);
    // audit event written with before/after
    const events = await auditTypes(compatibleAuto.automationId);
    expect(events).toContain("AUTOMATION_EFFECT_PIN_UPGRADED");
    // idempotent: re-run reports "unchanged"
    const again = await repinAutomationsForActionType({
      actionTypeId: created.action_type_id, tenantId, actorUserId,
      strategy: "latest-compatible", dryRun: false,
    });
    expect(again.results.find((r) => r.automationId === compatibleAuto.automationId)?.status).toBe("unchanged");
    await pool.query(`DELETE FROM action_type WHERE action_type_id = $1`, [created.action_type_id]);
  });
});
