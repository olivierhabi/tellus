// ---------------------------------------------------------------------------
// Edit-time blast radius for action-type changes.
//
// Answers: "if this action type's semantic definition became X, which
// active automations' pins would break?" — computed with the SAME
// classifyActionDefinitionChange() that activation validation + bulk repin
// use (never a divergence).
//
// Per-pin verdict:
//   pin version == CANDIDATE definition-version  → skipped (already current)
//   history snapshot of PINNED version exists    → classify →
//     identical    → "unchanged"
//     compatible   → "compatible"
//     breaking     → "breaking"
//   no snapshot (pre-history era pin)            → "unknown"
// ---------------------------------------------------------------------------

import type { Pool, PoolClient } from "pg";

import type { ActionDefinitionInput } from "../../actions/actionDefinitionCanonical";
import {
  classifyActionDefinitionChange,
  type ActionDefinitionChangeDetail,
} from "./actionDefinitionCompat";
import {
  findActiveVersionAutomationsPinningActionType,
  findDraftAutomationsPinningActionType,
  loadActionDefinitionSnapshot,
} from "./pinLookup";

export interface BlastRadiusResult {
  total: number;
  unchanged: number;
  compatible: number;
  breaking: number;
  unknown: number;
  sampleAutomationIds: string[];
  breakingChanges: ActionDefinitionChangeDetail[];
}

type Queryable = Pick<Pool, "query"> | Pick<PoolClient, "query">;

interface BlastEffectShape {
  type?: string;
  actionTypeId?: string | null;
  definitionVersion?: number | null;
  fallbackEffect?: BlastEffectShape | null;
}

function walkEffects(
  effect: BlastEffectShape | undefined | null,
  pins: Array<{ definitionVersion?: number | null }>,
  actionTypeId: string,
): void {
  if (!effect) return;
  if (effect.type === "action" && effect.actionTypeId === actionTypeId) {
    pins.push({ definitionVersion: effect.definitionVersion });
  }
  walkEffects(effect.fallbackEffect, pins, actionTypeId);
}

export async function computeActionTypeBlastRadius(
  db: Queryable,
  tenantId: string,
  actionTypeId: string,
  candidate: ActionDefinitionInput,
  candidateDefinitionVersion: number,
): Promise<BlastRadiusResult> {
  // Automations pinning the type in their DRAFT or their ACTIVE version.
  const draftHits = await findDraftAutomationsPinningActionType(
    db, tenantId, actionTypeId,
  );
  const activeIds = await findActiveVersionAutomationsPinningActionType(
    db, tenantId, actionTypeId,
  );
  const automationIds = [
    ...new Set([...draftHits.map((h) => h.automationId), ...activeIds]),
  ].sort();

  const result: BlastRadiusResult = {
    total: 0, unchanged: 0, compatible: 0, breaking: 0, unknown: 0,
    sampleAutomationIds: [], breakingChanges: [],
  };
  const samples: string[] = [];

  for (const automationId of automationIds) {
    // Read the LATEST draft's pin for this type (draft is what will be
    // re-activated next; active-version pins are replaced on next save).
    const draftRows = await db.query<{ definition: unknown }>(
      `SELECT draft_definition AS definition FROM automation
        WHERE automation_id = $1 AND status <> 'archived'`,
      [automationId],
    );
    const definition = draftRows.rows[0]?.definition as {
      effects?: BlastEffectShape[];
    } | undefined;
    const pins: Array<{ definitionVersion?: number | null }> = [];
    for (const root of definition?.effects ?? []) walkEffects(root, pins, actionTypeId);
    for (const pin of pins) {
      result.total += 1;
      const pinnedVersion = pin.definitionVersion ?? null;
      if (!pinnedVersion || pinnedVersion === candidateDefinitionVersion) {
        result.unchanged += 1;
        continue;
      }
      const snapshot = await loadActionDefinitionSnapshot(
        db, actionTypeId, pinnedVersion,
      );
      if (!snapshot) {
        result.unknown += 1;
        if (samples.length < 10) samples.push(automationId);
        continue;
      }
      const classification = classifyActionDefinitionChange(snapshot, candidate);
      if (classification.kind === "breaking") {
        result.breaking += 1;
        if (samples.length < 10) samples.push(automationId);
        for (const detail of classification.changes) {
          if (
            detail.severity === "breaking" &&
            !result.breakingChanges.some(
              (c) => c.code === detail.code && c.message === detail.message,
            )
          ) {
            result.breakingChanges.push(detail);
          }
        }
      } else if (classification.kind === "compatible") {
        result.compatible += 1;
      } else {
        result.unchanged += 1;
      }
    }
  }
  result.sampleAutomationIds = samples;
  return result;
}
