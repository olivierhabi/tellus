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

import {
  canonicalActionDefinitionString,
  type ActionDefinitionInput,
} from "./actionDefinitionCanonical";

export interface ActionDefinitionHashInput extends ActionDefinitionInput {}

/**
 * Compute the canonical sha256 hash of an action-type definition.
 * Returns a hex string. Pure: no I/O, no side-effects.
 *
 * Since the pin-hash rollout this delegates to the STRICT canonicalizer in
 * actionDefinitionCanonical.ts (object keys sorted recursively, parameters
 * sorted by apiName and reduced to {apiName, dataType, required,
 * defaultValue}) so that a hash stamped onto an Automate effect pin is
 * byte-identical to the hash recomputed at validation time from the DB row.
 * The previous JSON.stringify-based canonicalization kept insertion key
 * order and could disagree across producers of the same definition.
 */
export function hashActionDefinition(input: ActionDefinitionHashInput): string {
  return createHash("sha256")
    .update(canonicalActionDefinitionString(input), "utf8")
    .digest("hex");
}
