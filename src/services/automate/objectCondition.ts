// ---------------------------------------------------------------------------
// Automate object-set condition: effective-query composition.
//
// An objects-added / objects-removed / objects-modified / run-on-all
// condition carries two separate fields:
//
//   condition.objectSet       — the canonical ObjectSet (base/reference/...).
//   condition.objectCondition — an optional canonical SearchJsonQueryV2
//                               property filter to narrow the monitored set.
//
// The *effective* object set is the base set AND the property filter:
//
//   { type: "filter", objectSet: condition.objectSet, where: condition.objectCondition }
//
// This module is the SINGLE builder for that effective set so preview,
// validation, scheduled evaluation, live evaluation, run-on-all enumeration,
// membership initialization, and membership-diff evaluation all compile the
// SAME query. It reuses the canonical OSS compiler (`compileObjectSet`
// already handles the `filter` node by AND-ing the `where` onto the plan) —
// Automate introduces no parallel filter logic and no new operators. The
// closed set of operators is `SearchJsonQueryV2` in
// `src/services/oss/objectSetDefinition.ts`.
//
// The condition fingerprint is a stable hash of the normalized effective
// condition (effective object set + event type + monitored properties +
// evaluation mode) so that a metadata-only automation edit (identical
// fingerprint) preserves membership and a real condition change (different
// fingerprint) triggers a controlled rebaseline.
// ---------------------------------------------------------------------------

import crypto from "crypto";
import { z } from "zod";
import {
  ObjectSet as CanonicalObjectSetSchemaValue,
  SearchJsonQueryV2,
  objectSetFingerprint,
} from "../oss/objectSetDefinition";

/** Canonical v2 property filter AST — the only filter shape Automate accepts. */
export const ObjectConditionSchema = SearchJsonQueryV2;
export type ObjectCondition = z.infer<typeof SearchJsonQueryV2>;

// Re-export the canonical object-set schema + fingerprint for callers.
export const CanonicalObjectSetSchema = CanonicalObjectSetSchemaValue;
export { objectSetFingerprint };

/**
 * The parsed objects-added/removed/modified/run-on-all condition shape that
 * carries an `objectCondition`. Mirrors `ObjectSetConditionSchema`.
 */
export interface ObjectSetConditionLike {
  type: "objects-added" | "objects-removed" | "objects-modified" | "run-on-all";
  evaluationMode: "live" | "scheduled" | "automation-dependent";
  objectSet: CanonicalObjectSet;
  objectCondition?: unknown;
  monitoredProperties?: string[];
}

/**
 * Build the canonical effective object set: the base set narrowed by the
 * optional property filter. Returns the base set unchanged when no filter
 * is present so live/base-set restrictions upstream are undisturbed.
 *
 * The result is always a valid `ObjectSet` (the canonical `filter` node) and
 * is the shape compiled by BOTH the preview loader and the runtime
 * evaluator — they cannot diverge.
 */
export function effectiveObjectSet(condition: {
  objectSet: unknown;
  objectCondition?: unknown;
}): unknown {
  const base = condition.objectSet;
  if (
    condition.objectCondition === undefined ||
    condition.objectCondition === null
  ) {
    return base;
  }
  return {
    type: "filter",
    objectSet: base,
    where: condition.objectCondition,
  };
}

/**
 * Validate the objectCondition structurally against the canonical
 * SearchJsonQueryV2 schema. Property-existence / operator-type / access
 * validation is performed separately in validation.ts against the resolved
 * object type metadata (it needs ontology context this pure helper avoids).
 */
export function parseObjectCondition(
  raw: unknown,
): { ok: true; value: unknown } | { ok: false; error: string } {
  const parsed = SearchJsonQueryV2.safeParse(raw);
  if (parsed.success) return { ok: true, value: parsed.data };
  return {
    ok: false,
    error: parsed.error.issues
      .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
      .join("; "),
  };
}

/**
 * Deterministic fingerprint of the whole effective condition. Two automation
 * versions whose normalized effective conditions hash to the same fingerprint
 * are semantically identical: membership may be copied forward without
 * replaying every object. A different fingerprint means the monitored set
 * changed and must rebaseline.
 *
 * Normalization: the effective object set hash (canonical), the event type,
 * the evaluation mode, and the monitored properties (lexically sorted) are
 * the only contributors — ordering of `monitoredProperties` and the order of
 * `and`/`or` children is NOT part of the hash (the canonical objectSet
 * fingerprint already normalizes the objectSet; monitoredProperties are
 * sorted here).
 */
export function conditionFingerprint(condition: {
  type: string;
  evaluationMode: string;
  objectSet: unknown;
  objectCondition?: unknown;
  monitoredProperties?: string[];
}): string {
  const effective = effectiveObjectSet(condition);
  const monitored = [...(condition.monitoredProperties ?? [])].sort();
  const normalized = JSON.stringify({
    objectSet: objectSetFingerprint(effective),
    type: condition.type,
    evaluationMode: condition.evaluationMode,
    monitoredProperties: monitored,
  });
  return crypto.createHash("sha256").update(normalized).digest("hex");
}

/**
 * True when the effective condition of `next` is semantically identical to
 * the effective condition of `prior` (same fingerprint). Used on activation
 * of a new automation version to decide copy-forward vs rebaseline.
 */
export function isSameEffectiveCondition(
  next: ObjectSetConditionLike,
  prior: ObjectSetConditionLike,
): boolean {
  return (
    conditionFingerprint(next) === conditionFingerprint(prior)
  );
}

/** Type re-export for callers that want the canonical ObjectSet type. */
export type CanonicalObjectSet = z.infer<typeof CanonicalObjectSetSchema>;
