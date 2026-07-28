// ---------------------------------------------------------------------------
// Object Identity — stable object RIDs (Phase 2, OSSv2/OSv2 parity)
//
// The exact Palantir object-RID format is NOT publicly documented, so we
// use a stable Tellus namespace:
//
//     ri.tellus.main.object.<uuid>
//
// Rules:
//   - Action-created objects get a random UUID rid at creation time; the
//     rid is persisted in `object_instances.rid` (migration 138) and
//     stamped into the indexed document as `__rid`.
//   - Datasource-materialised objects that predate the rid column (or
//     bypass object_instances) get a DETERMINISTIC rid derived from
//     (ontologyId, objectTypeApiName, primaryKey) so reindexing is
//     idempotent and the rid is stable for the lifetime of the object.
// ---------------------------------------------------------------------------

import { createHash, randomUUID } from "node:crypto";

export const OBJECT_RID_PREFIX = "ri.tellus.main.object.";

/** Mint a fresh random object rid (action-created objects). */
export function mintObjectRid(): string {
  return `${OBJECT_RID_PREFIX}${randomUUID()}`;
}

/**
 * Deterministic rid for datasource rows that have no persisted rid yet.
 * UUID-shaped (v8 layout, sha256-derived) so downstream consumers can
 * treat all rids uniformly. Same input → same rid, forever.
 */
export function deterministicObjectRid(
  ontologyId: string,
  objectTypeApiName: string,
  primaryKey: string,
): string {
  const h = createHash("sha256")
    .update(`object-rid\0${ontologyId}\0${objectTypeApiName}\0${primaryKey}`)
    .digest("hex");
  // sha256 → uuid-shaped 8-4-4-4-12
  return (
    `${OBJECT_RID_PREFIX}${h.slice(0, 8)}-${h.slice(8, 12)}-` +
    `${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`
  );
}

export function isObjectRid(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(OBJECT_RID_PREFIX);
}
