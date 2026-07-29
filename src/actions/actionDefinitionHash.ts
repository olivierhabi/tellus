// ---------------------------------------------------------------------------
// Action Definition Hash
//
// Canonical, content-addressed hash of an action-type definition used by the
// migration workflow as an optimistic-concurrency token. The hash is computed
// from the *definition-bearing* columns only (parameters, rules, and the
// semantics triple that the migration is allowed to change together); it is
// NOT a hash of the whole `action_type` row (display_name / icon / etc. are
// irrelevant to migration safety). Including the semanticsVersion in the hash
// makes a v1→v2 migration itself non-idempotent-by-hash (as intended: a
// re-submitted stale analysis after migration has a different hash and is
// rejected as stale).
//
// The hash is sha256 over a deterministic JSON canonicalization (sorted keys,
// no whitespace) of { parameters, rules, semanticsVersion, executionMode,
// deletePolicy }. It never contains sensitive payloads: action definitions
// are declarative schemas, not user data.
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";

export interface ActionDefinitionHashInput {
  parameters: unknown;
  rules: unknown;
  semanticsVersion?: number | null;
  executionMode?: string | null;
  deletePolicy?: string | null;
  functionConfig?: unknown;
}

/**
 * Deterministic JSON canonicalization: stringified with sorted keys. Handles
 * plain JSON-serializable inputs (objects, arrays, primitives). `undefined`
 * and `null` are normalized to `null` so a column set to `null` after migration
// 124 backfill hashes the same as one that was always null.
 */
function canonicalJson(value: unknown): string {
  const normalized = value === undefined ? null : value;
  return JSON.stringify(normalized, (_k, v) =>
    v === undefined ? null : v,
  );
}

/**
 * Compute the canonical sha256 hash of an action-type definition.
 * Returns a hex string. Pure: no I/O, no side-effects.
 */
export function hashActionDefinition(input: ActionDefinitionHashInput): string {
  const canonical = canonicalJson({
    parameters: input.parameters,
    rules: input.rules,
    semanticsVersion: input.semanticsVersion ?? null,
    executionMode: input.executionMode ?? null,
    deletePolicy: input.deletePolicy ?? null,
    functionConfig: input.functionConfig ?? null,
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}
