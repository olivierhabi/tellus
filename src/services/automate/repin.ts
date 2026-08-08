// ---------------------------------------------------------------------------
// Bulk re-pin of Automate Action effects onto the CURRENT action-type
// definition — keyed strictly through the compatibility classifier
// (actionDefinitionCompat.ts). Never upgrades across a breaking change.
//
// Classification per pinned effect:
//   pin already current                       → "unchanged"
//   pin history snapshot unavailable          → "needsManualReview"
//   classifier: identical                      → "migrated" (refreshed)
//   classifier: compatible                     → "migrated" (upgraded)
//   classifier: breaking                       → "needsManualReview"
//
// Idempotent: a repeated call re-classifies; already-migrated pins report
// "unchanged". Every APPLIED change emits one
// AUTOMATION_EFFECT_PIN_UPGRADED audit event with before/after version+hash
// and the acting principal.
// ---------------------------------------------------------------------------

import type { PoolClient } from "pg";

import { pool } from "../../db";
import { AutomationDraftSchema, type AutomationDraft } from "./contracts";
import { AutomationServiceError, appendAutomationAudit } from "./repository";
import {
  classifyActionDefinitionChange,
  type ActionDefinitionChangeDetail,
} from "./actionDefinitionCompat";
import {
  findDraftAutomationsPinningActionType,
  loadActionDefinitionSnapshot,
  loadActionTypeCurrent,
} from "./pinLookup";

export interface RepinInput {
  actionTypeId: string;
  tenantId: string;
  actorUserId: string;
  strategy: "latest-compatible";
  dryRun: boolean;
  requestId?: string;
}

export type RepinStatus = "migrated" | "needsManualReview" | "unchanged";

export interface RepinResultRow {
  automationId: string;
  status: RepinStatus;
  changes: ActionDefinitionChangeDetail[];
}

export interface RepinOutcome {
  actionTypeId: string;
  strategy: "latest-compatible";
  dryRun: boolean;
  results: RepinResultRow[];
}

const MANUAL_REVIEW_NO_SNAPSHOT: ActionDefinitionChangeDetail = {
  code: "PIN_SNAPSHOT_UNAVAILABLE",
  severity: "breaking",
  message:
    "No history snapshot exists for the pinned definition version — re-select the Action Type in the effect editor manually.",
};

/** Walk effects + fallback chains, yielding action pins for the type. */
function collectActionPins(
  definition: AutomationDraft,
  actionTypeId: string,
): Array<Extract<AutomationDraft["effects"][number], { type: "action" }>> {
  const found: Array<Extract<AutomationDraft["effects"][number], { type: "action" }>> = [];
  const walk = (effect: AutomationDraft["effects"][number] | undefined): void => {
    if (!effect) return;
    if (effect.type === "action" && effect.actionTypeId === actionTypeId) {
      found.push(effect);
    }
    if (effect.fallbackEffect) walk(effect.fallbackEffect);
  };
  for (const effect of definition.effects) walk(effect);
  return found;
}

export async function repinAutomationsForActionType(
  input: RepinInput,
): Promise<RepinOutcome> {
  const current = await loadActionTypeCurrent(pool, input.actionTypeId);
  if (!current) {
    throw new AutomationServiceError(
      "ACTION_NOT_FOUND",
      "The selected Action Type no longer exists.",
      404,
    );
  }
  const candidates = await findDraftAutomationsPinningActionType(
    pool,
    input.tenantId,
    input.actionTypeId,
  );
  const results: RepinResultRow[] = [];

  for (const candidate of candidates) {
    const outcome = await repinOne(candidate.automationId, input, current);
    results.push(outcome);
  }
  return {
    actionTypeId: input.actionTypeId,
    strategy: input.strategy,
    dryRun: input.dryRun,
    results: results.sort((a, b) => a.automationId.localeCompare(b.automationId)),
  };
}

async function repinOne(
  automationId: string,
  input: RepinInput,
  current: Awaited<ReturnType<typeof loadActionTypeCurrent>> & object,
): Promise<RepinResultRow> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN"); // dryRun reads are identical; always begun for FOR UPDATE correctness
    const locked = await client.query<{
      automation_id: string;
      definition: unknown;
    }>(
      `SELECT automation_id, draft_definition AS definition
         FROM automation
        WHERE automation_id = $1 AND tenant_id = $2
          AND status <> 'archived'
        FOR UPDATE`,
      [automationId, input.tenantId],
    );
    const row = locked.rows[0];
    if (!row) {
      await client.query("ROLLBACK");
      return { automationId, status: "needsManualReview", changes: [] };
    }
    const parsed = AutomationDraftSchema.safeParse(row.definition);
    if (!parsed.success) {
      await client.query("ROLLBACK");
      return {
        automationId,
        status: "needsManualReview",
        changes: [
          {
            code: "DRIFT_UNPARSABLE",
            severity: "breaking",
            message: "The stored draft does not satisfy the current Automate contract.",
          },
        ],
      };
    }
    const definition = parsed.data;
    const pins = collectActionPins(definition, input.actionTypeId);
    if (pins.length === 0) {
      await client.query("ROLLBACK");
      return { automationId, status: "unchanged", changes: [] };
    }

    const allChanges: ActionDefinitionChangeDetail[] = [];
    let needsManual = false;
    let migrated = false;
    for (const effect of pins) {
      if (
        effect.definitionVersion === current.definition_version &&
        (current.definition_hash === null ||
          effect.definitionHash === null ||
          effect.definitionHash === current.definition_hash)
      ) {
        continue; // already pinned to the current definition
      }
      const snapshot =
        effect.definitionVersion != null
          ? await loadActionDefinitionSnapshot(
              client,
              input.actionTypeId,
              effect.definitionVersion,
            )
          : null;
      if (!snapshot) {
        needsManual = true;
        allChanges.push(MANUAL_REVIEW_NO_SNAPSHOT);
        continue;
      }
      const classification = classifyActionDefinitionChange(
        snapshot,
        current.definition,
      );
      for (const detail of classification.changes) {
        if (!allChanges.some((c) => c.code === detail.code && c.message === detail.message)) {
          allChanges.push(detail);
        }
      }
      if (classification.kind === "breaking") {
        needsManual = true;
        continue;
      }
      effect.definitionVersion = current.definition_version;
      effect.definitionHash = current.definition_hash;
      migrated = true;
    }
    if (!needsManual && migrated) {
      if (!input.dryRun) {
        await client.query(
          `UPDATE automation
              SET draft_definition = $2::jsonb,
                  draft_revision = draft_revision + 1,
                  updated_at = now()
            WHERE automation_id = $1`,
          [automationId, JSON.stringify(definition)],
        );
        await appendAutomationAudit(client, {
          automationId,
          automationVersion: null,
          actorUserId: input.actorUserId,
          eventType: "AUTOMATION_EFFECT_PIN_UPGRADED",
          requestId: input.requestId,
          details: {
            actionTypeId: input.actionTypeId,
            strategy: input.strategy,
            targetDefinitionVersion: current.definition_version,
            targetDefinitionHash: current.definition_hash,
            strategyDryRun: false,
            changes: allChanges,
          },
        });
        await client.query("COMMIT");
      }
      return { automationId, status: "migrated", changes: allChanges };
    }
    await client.query("ROLLBACK");
    return {
      automationId,
      status: needsManual ? "needsManualReview" : "unchanged",
      changes: allChanges,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
